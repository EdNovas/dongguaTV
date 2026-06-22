const path = require('path');
const { SubscriptionStore } = require('./subscriptionStore');
const { loadTvboxConfig, pickTvboxFields } = require('./tvboxParser');
const { normalizeSites, normalizeParses, stableHash, summarizeSources } = require('./tvboxNormalizer');
const { parseLives } = require('./liveParser');
const { checkSourceHealth } = require('./tvboxHealthCheck');

function sanitizeSubscription(subscription) {
    if (!subscription) return null;
    return {
        ...subscription,
        rawConfig: undefined
    };
}

class TvboxService {
    constructor({ dataDir, httpClient }) {
        this.store = new SubscriptionStore(dataDir);
        this.httpClient = httpClient;
    }

    async expandWarehouses(warehouses, subscriptionId, options = {}) {
        const enabled = options.enabled !== false;
        const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 12;
        const result = {
            enabled,
            limit,
            attempted: 0,
            expanded: 0,
            errors: [],
            sources: [],
            parses: [],
            liveChannels: [],
            liveErrors: []
        };

        if (!enabled || !Array.isArray(warehouses) || warehouses.length === 0 || limit === 0) {
            return result;
        }

        for (const [warehouseIndex, warehouse] of warehouses.slice(0, limit).entries()) {
            result.attempted += 1;
            try {
                const childConfig = await loadTvboxConfig({ url: warehouse.url }, this.httpClient);
                const childFields = pickTvboxFields(childConfig);
                const sourceIdSalt = `${subscriptionId}:warehouse:${warehouse.url}`;
                const childSources = normalizeSites(childFields.sites, {
                    subscriptionId,
                    sourceIdSalt,
                    rootConfig: childFields
                }).map(source => ({
                    ...source,
                    warehouse: {
                        index: warehouseIndex,
                        name: warehouse.name,
                        url: warehouse.url
                    }
                }));
                const childParses = normalizeParses(childFields.parses, `${subscriptionId}:warehouse:${warehouseIndex}`);
                const childLives = await parseLives(childFields.lives, `${subscriptionId}:warehouse:${warehouseIndex}`, this.httpClient);

                result.sources.push(...childSources);
                result.parses.push(...childParses.map(parse => ({
                    ...parse,
                    sourceSubscriptionId: subscriptionId,
                    warehouse: {
                        index: warehouseIndex,
                        name: warehouse.name,
                        url: warehouse.url
                    }
                })));
                result.liveChannels.push(...childLives.channels.map(channel => ({
                    ...channel,
                    sourceSubscriptionId: subscriptionId,
                    warehouse: {
                        index: warehouseIndex,
                        name: warehouse.name,
                        url: warehouse.url
                    }
                })));
                result.liveErrors.push(...childLives.errors.map(error => ({
                    ...error,
                    warehouse: warehouse.name || warehouse.url
                })));
                result.expanded += 1;
            } catch (error) {
                result.errors.push({
                    index: warehouseIndex,
                    name: warehouse.name,
                    url: warehouse.url,
                    reason: error.code || 'warehouse-import-failed',
                    message: String(error.message || error).slice(0, 240)
                });
            }
        }

        return result;
    }

    listSubscriptions() {
        return this.store.getSubscriptions().map(sanitizeSubscription);
    }

    listSources() {
        return this.store.getSources();
    }

    getSource(sourceId) {
        return this.store.getSources().find(source => source.id === sourceId) || null;
    }

    updateSource(sourceId, patch) {
        const allowed = ['enabled', 'status', 'supportLevel'];
        const sources = this.store.getSources();
        const index = sources.findIndex(source => source.id === sourceId);
        if (index < 0) return null;

        const next = { ...sources[index] };
        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) {
                next[key] = patch[key];
            }
        }
        next.updatedAt = new Date().toISOString();
        sources[index] = next;
        this.store.saveSources(sources);
        return next;
    }

    listLiveChannels() {
        return this.store.getLiveChannels();
    }

    listLiveGroups() {
        const groups = new Map();
        for (const channel of this.store.getLiveChannels()) {
            const key = channel.group || '默认';
            groups.set(key, (groups.get(key) || 0) + 1);
        }
        return [...groups.entries()].map(([name, count]) => ({ name, count }));
    }

    async importSubscription(input) {
        const config = await loadTvboxConfig(input, this.httpClient);
        const isInlineConfig = !!(input.config && typeof input.config === 'object');
        const fields = pickTvboxFields(config);
        const subscriptionId = input.id || `tvbox-sub-${stableHash([
            input.url,
            input.filePath ? path.resolve(input.filePath) : '',
            input.name,
            JSON.stringify(fields.sites.map(site => site && (site.key || site.name || site.api)).slice(0, 20))
        ])}`;

        const shouldExpandWarehouses = input.expandWarehouses !== false
            && fields.warehouses.length > 0
            && fields.sites.length === 0
            && fields.lives.length === 0;
        const warehouseExpansion = await this.expandWarehouses(fields.warehouses, subscriptionId, {
            enabled: shouldExpandWarehouses,
            limit: input.warehouseLimit
        });
        const sources = normalizeSites(fields.sites, {
            subscriptionId,
            rootConfig: fields
        }).concat(warehouseExpansion.sources);
        const parses = normalizeParses(fields.parses, subscriptionId).concat(warehouseExpansion.parses);
        const liveResult = await parseLives(fields.lives, subscriptionId, this.httpClient);
        const liveChannels = liveResult.channels.concat(warehouseExpansion.liveChannels);
        const summary = {
            ...summarizeSources(sources, liveChannels, parses, fields.warehouses),
            expandedWarehouses: warehouseExpansion.expanded,
            attemptedWarehouses: warehouseExpansion.attempted,
            warehouseErrors: warehouseExpansion.errors.length
        };
        const timestamp = new Date().toISOString();

        const subscription = {
            id: subscriptionId,
            name: input.name || config.name || fields.warningText || input.url || input.filePath || 'TVBox Subscription',
            sourceType: 'tvbox',
            url: input.url || null,
            filePath: input.filePath || null,
            importKind: input.url ? 'url' : input.filePath ? 'file-path' : 'inline-config',
            localFileName: input.localFileName || null,
            enabled: input.enabled === undefined ? true : !!input.enabled,
            status: 'available',
            summary,
            metadata: {
                spider: fields.spider,
                jar: fields.jar,
                flags: fields.flags,
                rules: fields.rules,
                doh: fields.doh,
                wallpaper: fields.wallpaper,
                adsCount: Array.isArray(fields.ads) ? fields.ads.length : 0,
                warningText: fields.warningText,
                ijkCount: Array.isArray(fields.ijk) ? fields.ijk.length : 0,
                player: fields.player,
                ext: fields.ext,
                warehouses: fields.warehouses,
                warehouseCount: fields.warehouses.length,
                warehouseExpansion: {
                    enabled: warehouseExpansion.enabled,
                    limit: warehouseExpansion.limit,
                    attempted: warehouseExpansion.attempted,
                    expanded: warehouseExpansion.expanded,
                    errors: warehouseExpansion.errors
                },
                parserDiagnostics: fields.parserDiagnostics,
                liveErrors: liveResult.errors.concat(warehouseExpansion.liveErrors)
            },
            rawConfig: isInlineConfig ? config : undefined,
            createdAt: timestamp,
            updatedAt: timestamp
        };

        const existing = this.store.getSubscriptions().find(item => item.id === subscriptionId);
        if (existing && existing.createdAt) {
            subscription.createdAt = existing.createdAt;
        }

        const result = {
            subscription,
            sources,
            liveChannels,
            parses
        };
        this.store.upsertImportResult(result);

        return {
            subscription: sanitizeSubscription(subscription),
            summary,
            sources,
            liveChannels: liveResult.channels,
            parses,
            warehouses: fields.warehouses
        };
    }

    async refreshSubscription(subscriptionId) {
        const subscription = this.store.getSubscriptions().find(item => item.id === subscriptionId);
        if (!subscription) {
            throw new Error('Subscription not found.');
        }
        if (!subscription.url && !subscription.filePath && !subscription.rawConfig) {
            throw new Error('This subscription cannot be refreshed because it has no URL, file path, or stored local JSON snapshot.');
        }
        return this.importSubscription({
            id: subscription.id,
            name: subscription.name,
            url: subscription.url,
            filePath: subscription.filePath,
            config: subscription.rawConfig,
            localFileName: subscription.localFileName,
            enabled: subscription.enabled,
            expandWarehouses: true
        });
    }

    deleteSubscription(subscriptionId) {
        this.store.removeSubscription(subscriptionId);
    }

    async healthCheck(sourceId) {
        const source = this.getSource(sourceId);
        const result = await checkSourceHealth(source, this.httpClient);
        if (source) {
            const sources = this.store.getSources();
            const index = sources.findIndex(item => item.id === source.id);
            if (index >= 0) {
                const now = new Date().toISOString();
                sources[index] = {
                    ...sources[index],
                    status: result.status === 'available' ? 'available' : sources[index].status,
                    supportLevel: sources[index].supportLevel,
                    healthCheck: {
                        sourceId,
                        ...result,
                        checkedAt: result.checkedAt || now
                    },
                    updatedAt: now
                };
                this.store.saveSources(sources);
            }
        }
        return { sourceId, ...result };
    }

    diagnoseSource(sourceId, runtimeState = {}) {
        const source = this.getSource(sourceId);
        if (!source) {
            return {
                sourceId,
                status: 'error',
                playable: false,
                reason: 'source-not-found',
                message: 'Source was not found.',
                actions: ['Refresh subscriptions and try again.']
            };
        }

        if (source.status === 'plugin-required' || source.sourceType === 'plugin-required') {
            const bridgeRunning = !!(runtimeState.localJavaBridge && runtimeState.localJavaBridge.running);
            const bridgeConfigured = !!(runtimeState.settings && runtimeState.settings.catvodBridgeJarPath);
            return {
                sourceId,
                sourceName: source.name,
                status: 'plugin-required',
                playable: bridgeRunning,
                reason: bridgeRunning ? 'local-java-bridge-running' : 'plugin-runtime-required',
                message: bridgeRunning
                    ? 'This TVBox plugin source can be sent to the local Java Bridge. Current bridge stub mode may still return empty results until a real CatVod runtime is implemented.'
                    : 'This TVBox source requires a CatVod/Spider plugin runtime. It is recognized, but plugin code is not executed directly by DongguaTV.',
                actions: bridgeRunning
                    ? ['Use the bridge operation endpoints for controlled testing.', 'Keep using only trusted local runtime jars.']
                    : [
                        bridgeConfigured ? 'Start Local Bridge in Settings.' : 'Build Java Bridge in Settings.',
                        'Do not use subscription-provided spider.jar as a trusted runtime jar.'
                    ],
                runtime: {
                    localJavaBridgeRunning: bridgeRunning,
                    localJavaBridgeBaseUrl: runtimeState.localJavaBridge && runtimeState.localJavaBridge.baseUrl,
                    localJavaBridgeMode: runtimeState.localJavaBridge && runtimeState.localJavaBridge.mode
                }
            };
        }

        if (source.status === 'unsupported' || source.supportLevel === 'unsupported') {
            return {
                sourceId,
                sourceName: source.name,
                status: 'unsupported',
                playable: false,
                reason: 'unsupported-source-shape',
                message: 'This source is not a supported HTTP/MacCMS-compatible source in the current version.',
                actions: ['Disable or hide this source.', 'Refresh the subscription after the provider changes its config.']
            };
        }

        if (!source.enabled) {
            return {
                sourceId,
                sourceName: source.name,
                status: source.status,
                playable: false,
                reason: 'source-disabled',
                message: 'This source is disabled.',
                actions: ['Enable the source before searching or playback testing.']
            };
        }

        return {
            sourceId,
            sourceName: source.name,
            status: source.status,
            playable: source.status === 'available' || source.supportLevel === 'basic' || source.supportLevel === 'full',
            reason: 'http-source',
            message: 'This source is handled as a normal HTTP-compatible source. Use health check if search or detail requests fail.',
            actions: ['Run source health check.', 'If playback needs headers, use LocalProxy or external playback.']
        };
    }
}

function createTvboxService(options) {
    return new TvboxService(options);
}

module.exports = {
    createTvboxService
};
