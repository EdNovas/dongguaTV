/**
 * M3U8 广告过滤模块 v3.1
 * 
 * 架构：Cloudflare Worker 边缘代理过滤
 * M3U8 URL 通过 CORS_PROXY_URL (CF Worker) 路由：
 *   1. CF Worker 获取原始 M3U8 内容
 *   2. 移除所有 #EXT-X-DISCONTINUITY 标签（广告插入标记）
 *   3. 将相对 URL 重写为代理 URL（TS 分片也经过 Worker）
 *   4. 返回干净的 M3U8 给 HLS.js
 * 
 * 客户端模块负责：
 * - 提供 isEnabled() 供 play() 函数决定是否路由到代理
 * - 广告过滤 UI 开关（设置面板中的切换按钮）
 * - 设置持久化（localStorage）
 * 
 * 参考：https://github.com/eraycc/m3u8-proxy-script
 * 
 * @author DongguaTV
 * @version 3.1.0
 */

(function () {
    'use strict';

    // 调试：通过 URL 参数 ?no-adfilter 完全禁用广告过滤（包括 HLS loader）
    // 用于测试投屏等功能是否受 ad-filter 影响
    if (window.location.search.includes('no-adfilter')) {
        console.log('[广告过滤] ⚠️ 检测到 ?no-adfilter 参数，广告过滤模块已完全禁用');
        return;
    }

    // 配置
    const AD_FILTER_CONFIG = {
        enabled: true,                    // 总开关
        skipDiscontinuityAds: true,       // 跳过 DISCONTINUITY 后的广告分段
        skipFirstSegments: false,         // 是否跳过开头分段（可配置）
        firstSegmentSkipDuration: 0,      // 跳过开头的秒数（0 = 不跳过）
        minAdDuration: 3,                 // 广告最小时长（秒）
        maxAdDuration: 120,               // 广告最大时长（秒）
        maxConsecutiveAdSegments: 15,     // 广告最大连续分段数
        logEnabled: true,                 // 日志开关
        showNotification: true,           // 显示过滤通知

        // 已知广告域名模式
        adDomainPatterns: [
            // 国际广告平台
            'doubleclick',          // Google DoubleClick
            'googlesyndication',    // Google AdSense
            'googleadservices',     // Google Ads
            'adsystem',
            'adservice',

            // 国内广告平台 - 百度
            'baidu.com/adm',        // 百度广告
            'pos.baidu.com',        // 百度联盟
            'cpro.baidu',           // 百度推广
            'eclick.baidu',         // 百度点击
            'baidustatic.com/adm',

            // 国内广告平台 - 腾讯
            'gdt.qq.com',           // 腾讯广点通
            'l.qq.com',             // 腾讯广告
            'e.qq.com',             // 腾讯广告联盟
            'adsmind.gdtimg',       // 腾讯广告素材

            // 国内广告平台 - 阿里/优酷/UC
            'tanx.com',             // 阿里妈妈
            'alimama.com',          // 阿里妈妈广告
            'mmstat.com',           // 阿里统计
            'atanx.alicdn',         // 阿里广告
            'ykad.',                // 优酷广告
            'ykimg.com/material',   // 优酷广告素材
            'iusmob.',              // UC广告

            // 国内广告平台 - 字节跳动/穿山甲
            'pangle.',              // 穿山甲广告
            'pangolin.',            // 穿山甲
            'bytedance.com/ad',     // 字节广告
            'oceanengine.',         // 巨量引擎
            'csjad.',               // 穿山甲

            // 视频网站广告
            'iqiyiad.',             // 爱奇艺广告
            'iqiyi.com/cupid',      // 爱奇艺广告系统
            'cupid.iqiyi',          // 爱奇艺贴片广告
            'mgtvad.',              // 芒果TV广告
            'admaster.',            // 广告监测
            'miaozhen.',            // 秒针广告监测

            // 通用广告关键词
            'adcdn.',
            'ad-cdn.',
            '/ad/',
            '/ads/',
            'advert',
            'adsrv',
            'adpush',
            'adx.',
            'dsp.',
            'rtb.',                 // 实时竞价
            'ssp.',                 // 供应方平台
            'tracking',
            'analytics',
            'commercial',
            'insert.',
            'preroll',              // 前贴片广告
            'midroll',              // 中插广告
            'postroll'              // 后贴片广告
        ],

        // 需要保护的主流视频 CDN（不过滤这些域名）
        safeDomains: [
            // 资源站 CDN
            'hhuus.com',           // 豪华资源
            'bvvvvvvvvv1f.com',    // 暴风资源
            'play-cdn',            // 1080资源
            'modujx',              // 魔都资源
            'ffzy',                // 非凡资源
            'sdzy',                // 闪电资源
            'wujin',               // 无尽资源
            'heimuer',             // 黑木耳资源
            'lzizy',               // 量子资源

            // 主流云服务商 CDN
            'alicdn.com',
            'aliyuncs.com',
            'aliyun',
            'qcloud',
            'myqcloud.com',
            'ksyun',
            'ks-cdn',
            'huaweicloud',
            'hwcdn',
            'baidubce',
            'bcebos.com',
            'cdn.bcebos',

            // 国内 CDN 服务商
            'cdn.jsdelivr',
            'bootcdn',
            'staticfile',
            'unpkg',
            'cdnjs'
        ]
    };

    // 统计信息
    const stats = {
        totalAdsFiltered: 0,
        totalAdDuration: 0,
        sessionsFiltered: 0
    };

    // 日志函数
    const log = (...args) => {
        if (AD_FILTER_CONFIG.logEnabled) {
            console.log('[广告过滤]', ...args);
        }
    };

    /**
     * 检查 URL 是否匹配广告域名
     * @param {string} url - 要检查的 URL
     * @returns {boolean} 是否为广告域名
     */
    function isAdDomain(url) {
        if (!url) return false;
        const lowerUrl = url.toLowerCase();

        // 首先检查是否是安全域名
        for (const safe of AD_FILTER_CONFIG.safeDomains) {
            if (lowerUrl.includes(safe)) {
                return false;
            }
        }

        // 然后检查是否匹配广告域名模式
        for (const pattern of AD_FILTER_CONFIG.adDomainPatterns) {
            if (lowerUrl.includes(pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 解析 M3U8 播放列表
     * @param {string} content - M3U8 内容
     * @returns {Object} 解析结果
     */
    function parseM3U8(content) {
        const lines = content.split('\n').map(l => l.trim());
        const segments = [];
        let currentSegment = null;
        let discontinuityCount = 0;
        let currentDiscontinuityGroup = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                discontinuityCount++;
                currentDiscontinuityGroup = discontinuityCount;
                continue;
            }

            if (line.startsWith('#EXTINF:')) {
                // 解析时长
                const match = line.match(/#EXTINF:([\d.]+)/);
                const duration = match ? parseFloat(match[1]) : 0;
                currentSegment = {
                    duration,
                    discontinuityGroup: currentDiscontinuityGroup,
                    infLine: line,
                    lineIndex: i
                };
                continue;
            }

            if (currentSegment && line && !line.startsWith('#')) {
                currentSegment.url = line;
                currentSegment.urlLineIndex = i;
                currentSegment.isAdDomain = isAdDomain(line);
                segments.push(currentSegment);
                currentSegment = null;
            }
        }

        return {
            lines,
            segments,
            discontinuityCount,
            totalDuration: segments.reduce((sum, s) => sum + s.duration, 0)
        };
    }

    /**
     * 检测广告分段组
     * @param {Array} segments - 分段列表
     * @returns {Set} 需要移除的分段索引
     */
    function detectAdSegments(segments) {
        const adSegmentIndices = new Set();

        if (!AD_FILTER_CONFIG.skipDiscontinuityAds) {
            return adSegmentIndices;
        }

        // 1. 首先标记所有来自广告域名分段
        segments.forEach((seg, idx) => {
            if (seg.isAdDomain) {
                log(`域名过滤: 分段 #${idx} 来自广告域名`);
                adSegmentIndices.add(idx);
            }
        });

        // 2. 按 discontinuity 组分组分析
        const groups = {};
        segments.forEach((seg, idx) => {
            const group = seg.discontinuityGroup;
            if (!groups[group]) {
                groups[group] = [];
            }
            groups[group].push({ ...seg, index: idx });
        });

        const groupKeys = Object.keys(groups).map(Number).sort((a, b) => a - b);

        // 如果没有 discontinuity，尝试基于其他特征检测
        if (groupKeys.length <= 1) {
            return adSegmentIndices;
        }

        // 计算各组的时长，找到主内容组（通常是最长的）
        const groupDurations = {};
        let maxDuration = 0;
        let mainContentGroup = 0;
        let totalDuration = 0;

        for (const gKey of groupKeys) {
            const duration = groups[gKey].reduce((sum, s) => sum + s.duration, 0);
            groupDurations[gKey] = duration;
            totalDuration += duration;
            if (duration > maxDuration) {
                maxDuration = duration;
                mainContentGroup = gKey;
            }
        }

        // 详细日志：输出所有 discontinuity 组的信息（用于调试 1080 资源站）
        log(`📊 M3U8 分析详情: ${groupKeys.length} 个组, 主内容组=#${mainContentGroup} (${maxDuration.toFixed(1)}秒)`);
        for (const gKey of groupKeys) {
            const group = groups[gKey];
            const groupDuration = groupDurations[gKey];
            const isMain = gKey === mainContentGroup;
            const sampleUrl = group[0]?.url || '';
            const domain = sampleUrl.match(/https?:\/\/([^\/]+)/)?.[1] || 'unknown';
            log(`  组 #${gKey}: ${group.length} 分段, ${groupDuration.toFixed(1)}秒, 域名=${domain}${isMain ? ' [主内容]' : ''}`);
        }

        // 分析每个组
        for (const gKey of groupKeys) {
            const group = groups[gKey];
            const groupDuration = groupDurations[gKey];

            // 跳过主内容组
            if (gKey === mainContentGroup) {
                continue;
            }

            // 跳过时长超过广告上限的组（这些是内容组，不是广告）
            if (groupDuration > AD_FILTER_CONFIG.maxAdDuration) {
                continue;
            }

            // 广告特征检测:
            // 1. 总时长在广告范围内（3-120秒）
            // 2. 分段数较少（通常 < 15）
            // 3. 时长远小于主内容组

            const isAdByDuration = groupDuration >= AD_FILTER_CONFIG.minAdDuration &&
                groupDuration <= AD_FILTER_CONFIG.maxAdDuration;
            const isAdBySegmentCount = group.length <= AD_FILTER_CONFIG.maxConsecutiveAdSegments;
            const isAdByRatio = groupDuration < maxDuration * 0.1;  // 时长不到主内容的 10%

            // 计算该组在整个视频中的位置
            const gKeyIndex = groupKeys.indexOf(gKey);
            let positionBefore = 0;
            for (let i = 0; i < gKeyIndex; i++) {
                positionBefore += groupDurations[groupKeys[i]];
            }
            const positionPercent = totalDuration > 0 ? (positionBefore / totalDuration * 100) : 0;

            // 如果是视频开头的短分段组，很可能是广告
            const isAtStart = positionBefore < 10;  // 开头10秒内
            const isAtEnd = positionPercent > 90;   // 结尾10%

            // 调试日志
            log(`  💡 组 #${gKey} 分析: 时长${groupDuration.toFixed(1)}秒, 位置${positionBefore.toFixed(0)}秒(${positionPercent.toFixed(0)}%), ` +
                `符合时长=${isAdByDuration}, 符合分段数=${isAdBySegmentCount}, 符合比例=${isAdByRatio}, ` +
                `开头=${isAtStart}, 结尾=${isAtEnd}`);

            // 判断条件：满足广告时长范围 + 分段数条件，直接过滤
            // 广告是动态插入的，CDN 每次播放时在 DISCONTINUITY 点插入不同的广告
            // 非主内容的短分组就是广告
            if (isAdByDuration && isAdBySegmentCount) {
                log(`🎯 检测到广告组 #${gKey}: ${group.length} 分段, ${groupDuration.toFixed(1)}秒, 位置: ${positionBefore.toFixed(0)}秒` +
                    (isAtStart ? ' [片头]' : '') + (isAtEnd ? ' [片尾]' : ''));
                group.forEach(seg => adSegmentIndices.add(seg.index));
            }
        }

        return adSegmentIndices;
    }

    /**
     * 检测广告时间段（用于跳过模式）
     * 分析 M3U8 内容，返回广告在播放时间轴上的起止时间
     * @param {string} content - 原始 M3U8 内容
     * @returns {Object} { adRanges: [{start, end, duration}], adsRemoved: number, adsDuration: number }
     */
    function detectAdTimeRanges(content) {
        if (!AD_FILTER_CONFIG.enabled || !AD_FILTER_CONFIG.skipDiscontinuityAds) {
            return { adRanges: [], adsRemoved: 0, adsDuration: 0 };
        }

        // 主播放列表不处理
        if (content.includes('#EXT-X-STREAM-INF')) {
            return { adRanges: [], adsRemoved: 0, adsDuration: 0 };
        }

        if (!content.includes('#EXT-X-DISCONTINUITY')) {
            return { adRanges: [], adsRemoved: 0, adsDuration: 0 };
        }

        try {
            const parsed = parseM3U8(content);
            const adIndices = detectAdSegments(parsed.segments);

            if (adIndices.size === 0) {
                return { adRanges: [], adsRemoved: 0, adsDuration: 0 };
            }

            // 计算每个分段在时间轴上的累积起始时间
            const adRanges = [];
            let cumulativeTime = 0;
            let currentRangeStart = -1;
            let currentRangeEnd = -1;

            for (let i = 0; i < parsed.segments.length; i++) {
                const seg = parsed.segments[i];
                if (adIndices.has(i)) {
                    if (currentRangeStart < 0) {
                        currentRangeStart = cumulativeTime;
                    }
                    currentRangeEnd = cumulativeTime + seg.duration;
                } else {
                    // 当前分段不是广告，如果之前有广告段，关闭该 range
                    if (currentRangeStart >= 0) {
                        adRanges.push({
                            start: currentRangeStart,
                            end: currentRangeEnd,
                            duration: currentRangeEnd - currentRangeStart
                        });
                        currentRangeStart = -1;
                        currentRangeEnd = -1;
                    }
                }
                cumulativeTime += seg.duration;
            }
            // 处理最后一个 range（如果广告在末尾）
            if (currentRangeStart >= 0) {
                adRanges.push({
                    start: currentRangeStart,
                    end: currentRangeEnd,
                    duration: currentRangeEnd - currentRangeStart
                });
            }

            let adsDuration = 0;
            adIndices.forEach(idx => {
                adsDuration += parsed.segments[idx].duration;
            });

            // 记录检测到的广告时间段
            for (const range of adRanges) {
                log(`📍 广告时间段: ${range.start.toFixed(1)}s - ${range.end.toFixed(1)}s (${range.duration.toFixed(1)}秒)`);
            }

            return { adRanges, adsRemoved: adIndices.size, adsDuration };
        } catch (e) {
            console.error('[广告过滤] detectAdTimeRanges 错误:', e);
            return { adRanges: [], adsRemoved: 0, adsDuration: 0 };
        }
    }

    /**
     * 过滤 M3U8 内容，移除广告分段
     * @param {string} content - 原始 M3U8 内容
     * @returns {Object} { filtered: string, adsRemoved: number, adsDuration: number }
     */
    function filterM3U8(content) {
        if (!AD_FILTER_CONFIG.enabled) {
            return { filtered: content, adsRemoved: 0, adsDuration: 0 };
        }

        // 检查是否是主播放列表（包含 #EXT-X-STREAM-INF）
        if (content.includes('#EXT-X-STREAM-INF')) {
            // 主播放列表不处理
            return { filtered: content, adsRemoved: 0, adsDuration: 0 };
        }

        // 检查是否包含 DISCONTINUITY 标签
        if (!content.includes('#EXT-X-DISCONTINUITY')) {
            // 没有 DISCONTINUITY 标签，仍然检查域名黑名单
            const parsed = parseM3U8(content);
            const domainAds = parsed.segments.filter(s => s.isAdDomain);
            if (domainAds.length === 0) {
                return { filtered: content, adsRemoved: 0, adsDuration: 0 };
            }
        }

        try {
            const parsed = parseM3U8(content);

            log(`分析 M3U8: ${parsed.segments.length} 分段, ${parsed.discontinuityCount} 个 DISCONTINUITY, 总时长 ${parsed.totalDuration.toFixed(0)}秒`);

            const adIndices = detectAdSegments(parsed.segments);

            if (adIndices.size === 0) {
                return { filtered: content, adsRemoved: 0, adsDuration: 0 };
            }

            // 计算广告总时长
            let adsDuration = 0;
            adIndices.forEach(idx => {
                adsDuration += parsed.segments[idx].duration;
            });

            // 构建过滤后的内容
            const linesToRemove = new Set();
            adIndices.forEach(idx => {
                const seg = parsed.segments[idx];
                linesToRemove.add(seg.lineIndex);     // #EXTINF 行
                linesToRemove.add(seg.urlLineIndex);  // URL 行
            });

            // 智能移除广告分段和 DISCONTINUITY 标签
            // 关键：当广告位于两段内容之间时，保留一个 DISCONTINUITY 标签
            // 防止 HLS.js 遇到未标记的时间戳跳跃触发 MEDIA_ERROR
            const filteredLines = [];
            let hadContentBefore = false;  // 在当前位置之前是否有内容分段
            let removedAdGroup = false;    // 是否刚移除了一组广告

            for (let i = 0; i < parsed.lines.length; i++) {
                const line = parsed.lines[i];

                if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                    // 检查这个 DISCONTINUITY 后面的分段是否都是广告
                    let allAds = true;
                    let hasSegments = false;

                    for (let j = i + 1; j < parsed.lines.length; j++) {
                        const nextLine = parsed.lines[j];
                        if (nextLine.startsWith('#EXT-X-DISCONTINUITY') || nextLine.startsWith('#EXT-X-ENDLIST')) {
                            break;
                        }
                        if (nextLine && !nextLine.startsWith('#')) {
                            hasSegments = true;
                            const segIdx = parsed.segments.findIndex(s => s.url === nextLine);
                            if (segIdx >= 0 && !adIndices.has(segIdx)) {
                                allAds = false;
                                break;
                            }
                        }
                    }

                    if (hasSegments && allAds) {
                        // 这个 DISCONTINUITY 后面全是广告，标记移除
                        removedAdGroup = true;
                        continue;
                    }

                    // 如果之前移除了广告且前后都有内容，保留这个 DISCONTINUITY
                    if (removedAdGroup && hadContentBefore) {
                        filteredLines.push(line);
                        removedAdGroup = false;
                        continue;
                    }
                }

                if (!linesToRemove.has(i)) {
                    filteredLines.push(line);
                    // 跟踪是否已输出过内容分段
                    if (line && !line.startsWith('#')) {
                        const segIdx = parsed.segments.findIndex(s => s.url === line);
                        if (segIdx >= 0 && !adIndices.has(segIdx)) {
                            hadContentBefore = true;
                        }
                    }
                }
            }

            // 最终清理：移除连续的多余 DISCONTINUITY 标签
            const cleanedLines = [];
            for (let i = 0; i < filteredLines.length; i++) {
                const line = filteredLines[i];
                if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                    // 如果下一个非空行也是 DISCONTINUITY 或 ENDLIST，跳过当前
                    let nextNonEmpty = '';
                    for (let j = i + 1; j < filteredLines.length; j++) {
                        if (filteredLines[j].trim()) {
                            nextNonEmpty = filteredLines[j];
                            break;
                        }
                    }
                    if (nextNonEmpty.startsWith('#EXT-X-DISCONTINUITY') || nextNonEmpty.startsWith('#EXT-X-ENDLIST') || !nextNonEmpty) {
                        continue; // 跳过多余的 DISCONTINUITY
                    }
                }
                cleanedLines.push(line);
            }
            // 也移除开头的 DISCONTINUITY（第一个分段前不需要）
            const finalLines = [];
            let foundFirstSegment = false;
            for (const line of cleanedLines) {
                if (!foundFirstSegment && line.startsWith('#EXT-X-DISCONTINUITY')) {
                    continue; // 跳过第一个分段之前的 DISCONTINUITY
                }
                if (line.startsWith('#EXTINF:')) {
                    foundFirstSegment = true;
                }
                finalLines.push(line);
            }

            // 🔧 移除所有剩余的 DISCONTINUITY 标签
            // 广告移除后内容组之间不需要 DISCONTINUITY，
            // 且 HLS.js 在 DISCONTINUITY 处有音频采样率重置 bug 导致声音低沉
            const noDiscoLines = finalLines.filter(line => 
                !line.startsWith('#EXT-X-DISCONTINUITY')
            );
            const filtered = noDiscoLines.join('\n');

            // 更新统计
            stats.totalAdsFiltered += adIndices.size;
            stats.totalAdDuration += adsDuration;
            stats.sessionsFiltered++;

            log(`✅ 已过滤 ${adIndices.size} 个广告分段，总时长 ${adsDuration.toFixed(1)} 秒`);

            return {
                filtered,
                adsRemoved: adIndices.size,
                adsDuration
            };

        } catch (e) {
            console.error('[广告过滤] 解析错误:', e);
            return { filtered: content, adsRemoved: 0, adsDuration: 0 };
        }
    }


    /**
     * 注入广告过滤开关到设置面板 (可从外部调用)
     * @returns {boolean} 是否成功注入
     */
    function injectAdFilterUI() {
        const settingPanel = document.querySelector('.dplayer-setting-origin-panel');
        if (!settingPanel) return false;

        // 如果已经存在，不重复注入
        if (settingPanel.querySelector('.dplayer-setting-ad-filter')) {
            return true;
        }

        const html = `
            <div class="dplayer-setting-ad-filter" style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 5px; padding-top: 5px;">
                <div class="dplayer-setting-item" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;" id="ad-filter-toggle">
                    <span class="dplayer-label">广告过滤</span>
                    <div style="position: relative; width: 40px; height: 22px; background: ${AD_FILTER_CONFIG.enabled ? '#e50914' : 'rgba(255,255,255,0.2)'}; border-radius: 20px; transition: background 0.3s;">
                        <div class="ad-filter-knob" style="position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: #fff; border-radius: 50%; transition: transform 0.3s; transform: translateX(${AD_FILTER_CONFIG.enabled ? '18px' : '0'});"></div>
                    </div>
                </div>
            </div>
        `;
        settingPanel.insertAdjacentHTML('beforeend', html);

        // 绑定点击事件
        const toggle = settingPanel.querySelector('#ad-filter-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                AD_FILTER_CONFIG.enabled = !AD_FILTER_CONFIG.enabled;
                const bg = toggle.querySelector('div');
                const knob = toggle.querySelector('.ad-filter-knob');
                if (bg && knob) {
                    bg.style.background = AD_FILTER_CONFIG.enabled ? '#e50914' : 'rgba(255,255,255,0.2)';
                    knob.style.transform = `translateX(${AD_FILTER_CONFIG.enabled ? '18px' : '0'})`;
                }
                if (window.dp && window.dp.notice) {
                    window.dp.notice(AD_FILTER_CONFIG.enabled ? '🛡️ 广告过滤已开启' : '广告过滤已关闭');
                }
                // 保存设置
                try {
                    localStorage.setItem('donggua_ad_filter_enabled', AD_FILTER_CONFIG.enabled);
                } catch (e) { }
            });
        }

        log('✅ 广告过滤开关已注入到设置面板');
        return true;
    }

    /**
     * 创建广告过滤设置 UI
     * 使用多种策略确保按钮能正确注入到设置面板
     */
    function createSettingsUI() {
        // 策略1: 监听设置图标点击
        function setupSettingIconListener() {
            // 使用事件委托，监听整个 document 的点击
            document.addEventListener('click', (e) => {
                // 检查是否点击了设置图标
                const settingIcon = e.target.closest('.dplayer-setting-icon');
                if (settingIcon) {
                    // 延迟执行，等待 DPlayer 创建设置面板
                    setTimeout(injectAdFilterUI, 50);
                    setTimeout(injectAdFilterUI, 150);
                    setTimeout(injectAdFilterUI, 300);
                }
            }, true);
        }

        // 策略2: 使用 MutationObserver 监听整个 document.body
        function setupMutationObserver() {
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        // 检查是否有设置面板被添加
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList && node.classList.contains('dplayer-setting-origin-panel')) {
                                    setTimeout(injectAdFilterUI, 10);
                                } else if (node.querySelector && node.querySelector('.dplayer-setting-origin-panel')) {
                                    setTimeout(injectAdFilterUI, 10);
                                }
                            }
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // 10分钟后停止观察（防止内存泄漏）
            setTimeout(() => {
                observer.disconnect();
            }, 600000);
        }

        // 策略3: 定时检查（作为后备方案）
        function setupPeriodicCheck() {
            let attempts = 0;
            const maxAttempts = 60; // 最多检查30秒

            const checkInterval = setInterval(() => {
                attempts++;
                if (injectAdFilterUI() || attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                }
            }, 500);
        }

        // 初始化所有策略
        function init() {
            // 尝试立即注入
            injectAdFilterUI();

            // 设置点击监听
            setupSettingIconListener();

            // 设置 DOM 变更监听
            setupMutationObserver();

            // 设置后备定时检查
            setupPeriodicCheck();

            log('✅ 广告过滤 UI 监听已启动');
        }

        // 等待 DOM 准备就绪后初始化
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    /**
     * 加载保存的设置
     */
    function loadSettings() {
        try {
            const saved = localStorage.getItem('donggua_ad_filter_enabled');
            if (saved !== null) {
                AD_FILTER_CONFIG.enabled = saved === 'true';
            }
        } catch (e) { }
    }

    // 导出配置和函数到全局
    window.AdFilter = {
        config: AD_FILTER_CONFIG,
        stats,
        filterM3U8,
        parseM3U8,
        isAdDomain,
        isEnabled: () => AD_FILTER_CONFIG.enabled,
        enable: () => {
            AD_FILTER_CONFIG.enabled = true;
            try { localStorage.setItem('donggua_ad_filter_enabled', 'true'); } catch (e) { }
            log('广告过滤已启用');
        },
        disable: () => {
            AD_FILTER_CONFIG.enabled = false;
            try { localStorage.setItem('donggua_ad_filter_enabled', 'false'); } catch (e) { }
            log('广告过滤已禁用');
        },
        setLogEnabled: (enabled) => { AD_FILTER_CONFIG.logEnabled = enabled; },
        setNotificationEnabled: (enabled) => { AD_FILTER_CONFIG.showNotification = enabled; },
        getStats: () => ({ ...stats }),
        setSkipFirstSeconds: (seconds) => {
            AD_FILTER_CONFIG.skipFirstSegments = seconds > 0;
            AD_FILTER_CONFIG.firstSegmentSkipDuration = seconds;
        },
        initUI: injectAdFilterUI
    };

    // 初始化
    log('🚀 广告过滤模块 v3.1 加载中...');
    log('📡 架构: Cloudflare Worker 边缘代理过滤 (CORS_PROXY_URL)');
    loadSettings();
    createSettingsUI();

    log(`📊 配置: 启用=${AD_FILTER_CONFIG.enabled}, DISCONTINUITY过滤=${AD_FILTER_CONFIG.skipDiscontinuityAds}`);

})();
