// ========================================
// CORS API 代理 (Cloudflare Workers)
// ========================================
// 用于中转无法直接访问的视频资源站
// 
// 部署步骤:
// 1. 登录 https://dash.cloudflare.com
// 2. 进入 Workers & Pages → 创建 Worker
// 3. 将此文件内容粘贴到编辑器
// 4. 保存并部署
// 5. 复制 Worker URL 到 .env 中的 CORS_PROXY_URL
// ========================================

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request);
    }
}

// CORS 响应头
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    'Access-Control-Max-Age': '86400',
}

// 需要排除的响应头（这些头会影响流式传输）
const EXCLUDE_HEADERS = new Set([
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive'
])

async function handleRequest(request) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const targetUrlParam = reqUrl.searchParams.get('url');

    // 健康检查
    if (reqUrl.pathname === '/health') {
        return new Response('OK', { status: 200, headers: CORS_HEADERS });
    }

    // 必须有 url 参数
    if (!targetUrlParam) {
        return new Response(getHelpPage(reqUrl.origin), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
        });
    }

    // nofilter=1:只做 CORS + URL 重写,不做去广告(前端在"过滤后清单为空/不可播"时的兜底通道;
    //   子清单链接会继承该参数,整条播放链都不过滤)
    const noFilter = reqUrl.searchParams.get('nofilter') === '1';
    return handleProxyRequest(request, targetUrlParam, reqUrl.origin, noFilter);
}

async function handleProxyRequest(request, targetUrlParam, currentOrigin, noFilter) {
    // 防止递归调用
    if (targetUrlParam.startsWith(currentOrigin)) {
        return errorResponse('Loop detected: self-fetch blocked', 400);
    }

    // 验证 URL 格式
    if (!/^https?:\/\//i.test(targetUrlParam)) {
        return errorResponse('Invalid target URL', 400);
    }

    let targetURL;
    try {
        targetURL = new URL(targetUrlParam);
    } catch {
        return errorResponse('Invalid URL format', 400);
    }

    try {
        // 构建代理请求头 - 伪装成正常浏览器请求
        const headers = new Headers();

        // 设置 Referer 和 Origin 为目标域名（很多服务器会检查这个）
        headers.set('Referer', targetURL.origin + '/');
        headers.set('Origin', targetURL.origin);

        // 设置常见的浏览器 User-Agent
        headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 复制客户端的关键请求头
        const copyHeaders = ['range', 'accept', 'accept-language'];
        copyHeaders.forEach(h => {
            const val = request.headers.get(h);
            if (val) headers.set(h, val);
        });

        // 设置 Accept 头（如果客户端没有提供）
        if (!headers.has('accept')) {
            headers.set('Accept', '*/*');
        }

        const proxyRequest = new Request(targetURL.toString(), {
            method: request.method,
            headers: headers,
            body: request.method !== 'GET' && request.method !== 'HEAD'
                ? await request.arrayBuffer()
                : undefined,
        });

        // 设置超时 (20秒，视频流需要更长时间)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        let response = await fetch(proxyRequest, { signal: controller.signal });
        clearTimeout(timeoutId);

        // 📊 诊断日志(wrangler tail 可见)：只对失败请求打点(不刷屏成功的 .ts 分段)。
        //    server=cloudflare + 403 ⇒ 上游本身在 CF 后面、在封你 worker 的 IP(换头救不了)；404 ⇒ 链接失效/被按 IP 拒。
        if (!response.ok) {
            console.log(`[proxy] ${request.method} ${targetURL.host}${targetURL.pathname} first=${response.status} server=${response.headers.get('server') || '-'} cf-cache=${response.headers.get('cf-cache-status') || '-'} ct=${response.headers.get('content-type') || '-'}`);
        }

        // 🔁 防盗链回退：部分 CDN 带"外来 Referer/Origin"反而被拒(常见 403，也有用 404/401 隐藏的)。
        //    失败时去掉 Referer/Origin 再拉一次(仅 GET/HEAD、仅在失败时；成功才采用，否则保留首次结果)。
        //    注意：对"封 Cloudflare/境外 IP"的源无效(那是 IP 问题，换头救不了)，但能多救回"仅因 Referer 被拒"的源。
        if ([401, 403, 404, 451].includes(response.status) &&
            (request.method === 'GET' || request.method === 'HEAD')) {
            const retryHeaders = new Headers(headers);
            retryHeaders.delete('Referer');
            retryHeaders.delete('Origin');
            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(() => retryController.abort(), 20000);
            try {
                const retryResp = await fetch(
                    new Request(targetURL.toString(), { method: request.method, headers: retryHeaders }),
                    { signal: retryController.signal }
                );
                console.log(`[proxy] ${targetURL.host}${targetURL.pathname} noRefererRetry status=${retryResp.status} adopted=${retryResp.ok}`);
                if (retryResp.ok) response = retryResp;
            } catch (e) { console.log(`[proxy] ${targetURL.host}${targetURL.pathname} noRefererRetry threw ${e.name}`); /* 保留首次响应交给前端自动换源 */ }
            clearTimeout(retryTimeoutId);
        }

        // 构建响应头 - 先复制目标服务器的响应头，但排除 CORS 相关的头
        const responseHeaders = new Headers();

        // 需要排除的头（这些会影响 CORS 或传输）
        const excludeHeaders = new Set([
            'access-control-allow-origin',
            'access-control-allow-methods',
            'access-control-allow-headers',
            'access-control-expose-headers',
            'access-control-max-age',
            'access-control-allow-credentials',
            'content-encoding',
            'transfer-encoding',
            'connection',
            'keep-alive'
        ]);

        // 复制目标服务器的响应头（排除 CORS 相关）
        for (const [key, value] of response.headers) {
            if (!excludeHeaders.has(key.toLowerCase())) {
                responseHeaders.set(key, value);
            }
        }

        // 最后设置我们的 CORS 头（覆盖任何已有的）
        for (const [key, value] of Object.entries(CORS_HEADERS)) {
            responseHeaders.set(key, value);
        }

        // 检查是否是 m3u8 文件，如果是则重写里面的 URL
        const contentType = response.headers.get('content-type') || '';
        const isM3u8 = targetURL.pathname.endsWith('.m3u8') ||
            contentType.includes('mpegurl') ||
            contentType.includes('x-mpegurl');

        if (isM3u8 && response.ok) {
            // 读取 m3u8 内容并重写 URL
            const m3u8Content = await response.text();
            // nofilter 模式:代理前缀带上 nofilter=1,让子清单/分段链接也走无过滤通道
            const proxyPrefix = noFilter ? currentOrigin + '/?nofilter=1&url=' : currentOrigin + '/?url=';
            const rewrittenContent = noFilter
                ? rewriteNoFilter(m3u8Content, targetURL, proxyPrefix)
                : rewriteM3u8(m3u8Content, targetURL, currentOrigin);

            responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
            responseHeaders.delete('Content-Length'); // 长度已变化

            console.log(`[proxy] ${targetURL.host}${targetURL.pathname} FINAL=${response.status} m3u8=true`);
            return new Response(rewrittenContent, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders
            });
        }

        if (!response.ok) console.log(`[proxy] ${targetURL.host}${targetURL.pathname} FINAL=${response.status} m3u8=false`);
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });
    } catch (err) {
        const errorMsg = err.name === 'AbortError'
            ? 'Request timeout (20s)'
            : 'Proxy Error: ' + (err.message || '代理请求失败');
        return errorResponse(errorMsg, 502);
    }
}

/**
 * 重写 m3u8 内容：
 * 1. 过滤 SSAI 广告分段（整组移除）
 * 2. 将 URL 改为经过代理的 URL（解决防盗链）
 * 
 * 广告过滤策略（v2.2 from KI）：
 *   - 先提取全局 M3U8 头部标签
 *   - 按 DISCONTINUITY 将分段分成多个"组"
 *   - 广告组特征：3-120秒 且 <15个分段 → 整组移除
 *   - 保留所有非广告组（可能有多个主内容组）
 *   - 🛡️ 保险丝(v2.3)："广告"占比 >50% 或过滤后 0 个内容组 → 判定为"均匀切块"而非贴片，整份放行不过滤；
 *     任何情况下都绝不输出 0 分片的清单（那会让 hls.js 静默死掉、前端无任何错误可感知）
 *   - ?nofilter=1 → 完全跳过广告判定，只做 CORS/URL 重写（前端兜底通道）
 */
function rewriteM3u8(content, baseUrl, proxyOrigin) {
    const baseOrigin = baseUrl.origin;
    const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
    const lines = content.split('\n');

    // ===== 检查是否是主播放列表（含 #EXT-X-STREAM-INF）=====
    // 主播放列表不包含广告分段，只做 URL 重写
    const hasStreamInf = lines.some(l => l.trim().startsWith('#EXT-X-STREAM-INF'));
    if (hasStreamInf) {
        return rewriteMasterPlaylist(lines, baseOrigin, basePath, proxyOrigin);
    }

    // ===== 子播放列表：过滤广告 =====

    // 📺 直播(滑动窗口,无 #EXT-X-ENDLIST):时长启发式对滑窗毫无意义(窗口边缘常有 DISCONTINUITY 切出的小组会被
    //    当广告删掉),且过滤路径会硬加 ENDLIST 把直播变成 VOD(hls.js 不再刷新清单,几分钟后播完停住)。直播只改 URL。
    if (!lines.some(l => l.trim() === '#EXT-X-ENDLIST')) {
        return rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin);
    }

    // 第一步：提取全局头部标签（在第一个 #EXTINF 或 #EXT-X-DISCONTINUITY 之前的标签）
    const globalHeaders = [];
    let bodyStartIdx = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('#EXTINF:') || trimmed === '#EXT-X-DISCONTINUITY') {
            bodyStartIdx = i;
            break;
        }
        // 跳过广告相关元标签
        if (trimmed.startsWith('#EXT-X-CUE') || trimmed.startsWith('#EXT-X-DATERANGE') ||
            trimmed.startsWith('#EXT-X-SCTE35')) {
            continue;
        }
        if (trimmed === '#EXT-X-ENDLIST') continue;
        if (trimmed === '' && i < 3) { globalHeaders.push(lines[i]); continue; }
        if (trimmed.startsWith('#') || trimmed === '') {
            globalHeaders.push(lines[i]);
        }
        bodyStartIdx = i + 1;
    }

    // 第二步：按 DISCONTINUITY 分组
    const groups = [];
    let currentGroup = { segments: [], duration: 0, segCount: 0 };

    for (let i = bodyStartIdx; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // 跳过广告元标签
        if (trimmed.startsWith('#EXT-X-CUE-OUT') || trimmed.startsWith('#EXT-X-CUE-IN') ||
            trimmed.startsWith('#EXT-X-CUE') || trimmed.startsWith('#EXT-X-DATERANGE') ||
            trimmed.startsWith('#EXT-X-SCTE35')) {
            continue;
        }

        // DISCONTINUITY → 推入当前组，开始新组
        if (trimmed === '#EXT-X-DISCONTINUITY') {
            if (currentGroup.segCount > 0) {
                groups.push(currentGroup);
            }
            currentGroup = { segments: [], duration: 0, segCount: 0 };
            continue;
        }

        // ENDLIST → 跳过（最后统一加）
        if (trimmed === '#EXT-X-ENDLIST') continue;

        // EXTINF → 分段
        if (trimmed.startsWith('#EXTINF:')) {
            const durMatch = trimmed.match(/#EXTINF:([\d.]+)/);
            const dur = durMatch ? parseFloat(durMatch[1]) : 0;
            currentGroup.duration += dur;
            currentGroup.segCount++;
            currentGroup.segments.push(lines[i]);
            // 下一行是 URL
            if (i + 1 < lines.length) {
                i++;
                currentGroup.segments.push(lines[i]);
            }
            continue;
        }

        // 空行或其他标签 → 放入当前组
        if (trimmed !== '') {
            currentGroup.segments.push(lines[i]);
        }
    }

    // 最后一组
    if (currentGroup.segCount > 0) {
        groups.push(currentGroup);
    }

    // 如果只有一组或无组，不需要过滤
    if (groups.length <= 1) {
        return rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin);
    }

    // 第三步：过滤广告组（基于 DISCONTINUITY 分组）
    const keptGroups = [];
    let adsRemoved = 0;
    let adDuration = 0;
    let totalDuration = 0;

    for (const g of groups) {
        totalDuration += g.duration;
        // 广告特征：3-120秒 且 <15个分段
        const isAd = g.duration >= 3 && g.duration <= 120 && g.segCount < 15;

        if (isAd) {
            adsRemoved++;
            adDuration += g.duration;
        } else {
            keptGroups.push(g);
        }
    }

    // 🚨 "均匀切块"不是广告 —— 事故根因(2026-08 生产实测):部分资源站(如 ryplay17 系)开始把整集按【每 5 个分段
    //    一个 #EXT-X-DISCONTINUITY】打包(1724 分片/345 组,每组 ~20s,零广告),上面的时长规则会把【所有】组都判成
    //    广告 → 输出一份只剩头部、一个 EXTINF 都没有的"合法"m3u8 → hls.js 只报一个非致命 levelEmptyError 然后
    //    永远静默(readyState 0、无 fragment 请求、不触发 <video>.error) → 播放器停在 00:00、点播放没反应、
    //    console 干净 → 前端分诊拿 master 探测又看到 #EXTM3U 判"代理正常"再重试 → 每个源白等 14s+8s 才换下一个,
    //    用户体验就是"所有资源站都播不了"。真实 SSAI 广告只占整集很小一部分(实测 ffzy 4 组/74s、ikun 7 组/123s,
    //    均 <2%);一旦"广告"占比过半、或过滤后一个内容组都不剩,说明这份清单根本不是"正片+贴片"结构,过滤规则不适用,
    //    必须整份保留(宁可有广告也不能没画面)。
    const adShare = totalDuration > 0 ? adDuration / totalDuration : 0;
    if (adsRemoved > 0 && (keptGroups.length === 0 || adShare > 0.5)) {
        console.log(`[AdFilter] SKIP: ${adsRemoved}/${groups.length} groups look like ads (${adDuration.toFixed(0)}s / ${totalDuration.toFixed(0)}s = ${(adShare * 100).toFixed(0)}%) → uniform chunking, not SSAI ads; passing playlist through unfiltered`);
        return rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin);
    }

    // 第三步 B：清理组内嵌入的单条广告/追踪分段
    // 例如：尾部 0.01s 的 unibet666.vip 追踪像素，或中间插入的跨域广告 URL
    for (const g of keptGroups) {
        const cleanedSegments = [];
        for (let i = 0; i < g.segments.length; i++) {
            const line = g.segments[i];
            const trimmed = line.trim();

            // 检查 EXTINF + 下一行 URL 的组合
            if (trimmed.startsWith('#EXTINF:')) {
                const durMatch = trimmed.match(/#EXTINF:([\d.]+)/);
                const dur = durMatch ? parseFloat(durMatch[1]) : 0;
                const nextLine = (i + 1 < g.segments.length) ? g.segments[i + 1].trim() : '';

                // 判断是否为嵌入式广告/追踪分段：
                // 1) 极短时长 (< 0.5s) 且目标是完整 URL（非相对路径 .ts）
                // 2) URL 指向已知广告/赌博/追踪域名
                const isTracker = dur < 0.5 && /^https?:\/\//i.test(nextLine) && !/\.ts(\?|$)/i.test(nextLine);
                const isAdDomain = /^https?:\/\//i.test(nextLine) && /\.(vip|bet|casino|click|top|xyz|buzz)\//i.test(nextLine);

                if (isTracker || isAdDomain) {
                    // 跳过这个 EXTINF 和下一行的 URL
                    adsRemoved++;
                    adDuration += dur;
                    i++; // 跳过 URL 行
                    continue;
                }
            }

            cleanedSegments.push(line);
        }
        g.segments = cleanedSegments;
    }

    // 如果没有过滤掉任何组，直接做 URL 重写
    if (adsRemoved === 0) {
        return rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin);
    }

    // 第四步：重建 M3U8
    const output = [];

    // 输出全局头部（跳过 TARGETDURATION，后面重新计算）
    let maxSegDur = 0;
    for (const g of keptGroups) {
        for (const line of g.segments) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
                const m = t.match(/#EXTINF:([\d.]+)/);
                if (m) maxSegDur = Math.max(maxSegDur, Math.ceil(parseFloat(m[1])));
            }
        }
    }

    for (const line of globalHeaders) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXT-X-TARGETDURATION')) {
            output.push(`#EXT-X-TARGETDURATION:${maxSegDur || 4}`);
        } else if (trimmed.includes('URI="')) {
            // 🔑 头部的 #EXT-X-KEY / #EXT-X-MAP(AES-128 源常把 KEY 放在第一个 EXTINF 之前):相对 URI 必须解析并走代理,
            //    否则 hls.js 按响应 URL(worker 域)去拼 → 拉到 worker 的帮助页当密钥 → 解密失败(未过滤路径早就这么做,过滤路径漏了)
            output.push(line.replace(/URI="([^"]+)"/g, (match, uri) => {
                const absoluteUrl = resolveUrl(uri, baseOrigin, basePath);
                return `URI="${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}"`;
            }));
        } else {
            output.push(line);
        }
    }

    // 输出保留的分段组（TS 分段直连 CDN，不走代理）
    // 组与组之间保留 DISCONTINUITY，告知解码器重置时间戳（防止音画不同步）
    for (let gi = 0; gi < keptGroups.length; gi++) {
        if (gi > 0) {
            output.push('#EXT-X-DISCONTINUITY');
        }
        const g = keptGroups[gi];
        for (const line of g.segments) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                if (trimmed.includes('URI="')) {
                    output.push(line.replace(/URI="([^"]+)"/g, (match, uri) => {
                        const absoluteUrl = resolveUrl(uri, baseOrigin, basePath);
                        return `URI="${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}"`;
                    }));
                } else {
                    output.push(line);
                }
            } else {
                const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
                output.push(absoluteUrl);
            }
        }
    }

    output.push('#EXT-X-ENDLIST');

    // 🔒 最后一道闸:无论上面怎么判,绝不返回一份 0 分片的清单(那等于给播放器一个"合法的空"——静默死亡)。
    if (!output.some(l => l.trim().startsWith('#EXTINF:'))) {
        console.log(`[AdFilter] SKIP: filtered result has 0 segments (${groups.length} groups) → passing playlist through unfiltered`);
        return rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin);
    }

    console.log(`[AdFilter] Removed ${adsRemoved} ad groups (${adDuration.toFixed(1)}s), kept ${keptGroups.length} content groups (${groups.length} total)`);

    return output.join('\n');
}

/**
 * 无过滤模式（?nofilter=1）：不做任何广告判定，只做 URL 重写。
 *   - 主清单:子清单 URL → 代理(保留 nofilter=1,整条链都不过滤)
 *   - 子清单:分段 → 绝对 URL 直连 CDN;URI="…"(密钥/初始化段) → 代理
 */
function rewriteNoFilter(content, baseUrl, proxyPrefix) {
    const baseOrigin = baseUrl.origin;
    const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
    const lines = content.split('\n');
    const isMaster = lines.some(l => l.trim().startsWith('#EXT-X-STREAM-INF'));
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
                output.push(lines[i].replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxyPrefix}${encodeURIComponent(resolveUrl(uri, baseOrigin, basePath))}"`));
            } else {
                output.push(lines[i]);
            }
        } else {
            const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
            output.push(isMaster ? proxyPrefix + encodeURIComponent(absoluteUrl) : absoluteUrl);
        }
    }
    return output.join('\n');
}

/**
 * 主播放列表（含 #EXT-X-STREAM-INF）→ 只做 URL 重写
 */
function rewriteMasterPlaylist(lines, baseOrigin, basePath, proxyOrigin) {
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            // #EXT-X-MEDIA / #EXT-X-SESSION-KEY 等带 URI="…" 的标签同样要走代理
            if (trimmed.includes('URI="')) {
                output.push(lines[i].replace(/URI="([^"]+)"/g, (match, uri) => `URI="${proxyOrigin}/?url=${encodeURIComponent(resolveUrl(uri, baseOrigin, basePath))}"`));
            } else {
                output.push(lines[i]);
            }
        } else {
            // 子播放列表 URL → 代理重写
            const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
            output.push(`${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}`);
        }
    }
    return output.join('\n');
}

/**
 * 纯 URL 重写（无 DISCONTINUITY 广告过滤，但仍清理嵌入式追踪分段）
 */
function rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin) {
    const output = [];
    let skippedCount = 0;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // 检查嵌入式广告/追踪分段
        if (trimmed.startsWith('#EXTINF:')) {
            const durMatch = trimmed.match(/#EXTINF:([\d.]+)/);
            const dur = durMatch ? parseFloat(durMatch[1]) : 0;
            const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';

            const isTracker = dur < 0.5 && /^https?:\/\//i.test(nextLine) && !/\.ts(\?|$)/i.test(nextLine);
            const isAdDomain = /^https?:\/\//i.test(nextLine) && /\.(vip|bet|casino|click|top|xyz|buzz)\//i.test(nextLine);

            if (isTracker || isAdDomain) {
                skippedCount++;
                i++; // 跳过 URL 行
                continue;
            }
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
                output.push(lines[i].replace(/URI="([^"]+)"/g, (match, uri) => {
                    const absoluteUrl = resolveUrl(uri, baseOrigin, basePath);
                    return `URI="${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}"`;
                }));
            } else {
                output.push(lines[i]);
            }
        } else {
            // TS/媒体分段 → 直连 CDN
            const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
            output.push(absoluteUrl);
        }
    }
    if (skippedCount > 0) {
        console.log(`[AdFilter] rewriteUrlsOnly: removed ${skippedCount} inline tracker(s)`);
    }
    return output.join('\n');
}

/**
 * 解析相对 URL 为绝对 URL
 */
function resolveUrl(url, baseOrigin, basePath) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url; // 已经是绝对 URL
    }
    if (url.startsWith('//')) {
        return 'https:' + url; // 协议相对 URL
    }
    if (url.startsWith('/')) {
        return baseOrigin + url; // 根相对 URL
    }
    return baseOrigin + basePath + url; // 路径相对 URL
}

function errorResponse(error, status = 400) {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
    });
}

function getHelpPage(origin) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>CORS API 代理</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
               max-width: 700px; margin: 50px auto; padding: 20px; line-height: 1.6; 
               background: #1a1a2e; color: #eee; }
        h1 { color: #e50914; }
        code { background: #16213e; padding: 3px 8px; border-radius: 4px; }
        pre { background: #16213e; padding: 15px; border-radius: 8px; overflow-x: auto; }
        .example { background: #0f3460; padding: 15px; border-left: 4px solid #e50914; margin: 20px 0; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>🌐 CORS API 代理</h1>
    <p>用于中转无法直接访问的视频资源站 API 和视频流</p>
    
    <h2>使用方法</h2>
    <div class="example">
        <code>${origin}/?url=目标URL</code>
    </div>
    
    <h2>示例</h2>
    <pre>${origin}/?url=https://example.com/video.m3u8</pre>
    
    <h2>支持的功能</h2>
    <ul>
        <li>✅ 代理 HLS (m3u8) 视频流</li>
        <li>✅ 代理资源站 API 请求</li>
        <li>✅ 支持 Range 请求（视频快进/快退）</li>
        <li>✅ 完整的 CORS 头支持</li>
        <li>✅ 超时保护（15秒）</li>
    </ul>
    
    <p style="margin-top: 40px; color: #888; font-size: 12px;">
        配合 dongguaTV 使用：在 .env 中设置 CORS_PROXY_URL=${origin}
    </p>
</body>
</html>`;
}
