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

    return handleProxyRequest(request, targetUrlParam, reqUrl.origin);
}

async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
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
        const response = await fetch(proxyRequest, { signal: controller.signal });
        clearTimeout(timeoutId);

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
            const rewrittenContent = rewriteM3u8(m3u8Content, targetURL, currentOrigin);

            responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
            responseHeaders.delete('Content-Length'); // 长度已变化

            return new Response(rewrittenContent, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders
            });
        }

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

    // 第三步：过滤广告组
    const keptGroups = [];
    let adsRemoved = 0;
    let adDuration = 0;

    for (const g of groups) {
        // 广告特征：3-120秒 且 <15个分段
        const isAd = g.duration >= 3 && g.duration <= 120 && g.segCount < 15;

        if (isAd) {
            adsRemoved++;
            adDuration += g.duration;
        } else {
            keptGroups.push(g);
        }
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
        } else {
            output.push(line);
        }
    }

    // 输出保留的分段组（TS 分段直连 CDN，不走代理）
    for (const g of keptGroups) {
        for (const line of g.segments) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                // 标签行 → URI="" 中的 key 文件仍走代理
                if (trimmed.includes('URI="')) {
                    output.push(line.replace(/URI="([^"]+)"/g, (match, uri) => {
                        const absoluteUrl = resolveUrl(uri, baseOrigin, basePath);
                        return `URI="${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}"`;
                    }));
                } else {
                    output.push(line);
                }
            } else {
                // TS/媒体 URL → 直连 CDN（不走代理，提升速度）
                const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
                output.push(absoluteUrl);
            }
        }
    }

    output.push('#EXT-X-ENDLIST');

    console.log(`[AdFilter] Removed ${adsRemoved} ad groups (${adDuration.toFixed(1)}s), kept ${keptGroups.length} content groups (${groups.length} total)`);

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
            output.push(lines[i]);
        } else {
            // 子播放列表 URL → 代理重写
            const absoluteUrl = resolveUrl(trimmed, baseOrigin, basePath);
            output.push(`${proxyOrigin}/?url=${encodeURIComponent(absoluteUrl)}`);
        }
    }
    return output.join('\n');
}

/**
 * 纯 URL 重写（无广告过滤，TS 直连 CDN）
 */
function rewriteUrlsOnly(lines, baseOrigin, basePath, proxyOrigin) {
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
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
