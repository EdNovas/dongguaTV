// Service Worker with Image Caching for dongguaTV
// v25: 直播台标(跨域图片)Cache-First 缓存 + /api/live/channels SWR(秒开)
// v27: 🚨 全站"点播放没反应"事故修复——SW 误把【CORS 代理的视频请求】当 HTML 页面缓存。
//      代理地址形如 https://cors.ednovas.video/?url=<真实m3u8>,其 pathname 恰好是 '/',而策略2
//      (HTML SWR)的条件 `url.pathname === '/'` 没有同源检查、且排在"跨域跳过"之前 → 每个 m3u8/ts
//      分片都走了缓存逻辑;分片是 206 Partial Content,Cache API 的 put() 遇 206 直接抛异常 → 响应失败,
//      播放器拿不到任何分片,表现为"所有资源站都播不了、点播放无反应、console 无报错"(错误发生在 SW 内)。
//      旧代码只跳过 'workers.dev' 域名,用【自定义域名】的代理(cors.ednovas.video)完全不在豁免内。
//      修:fetch 入口先做三条硬豁免——媒体流(video/audio/Range)、任何带 ?url= 的代理请求、非同源非图片请求。
// v26: 离线/弱网加固——①静态资源(libs)策略修复:原 './' 前缀匹配绝对 URL 永不命中(死代码),libs 全落
//      Network-First,弱网可能白屏;改按 pathname 匹配,真正 SWR。②导航兜底:带 ?play= 等查询参数的深链
//      cache.match 精确匹配不命中预缓存 './',断网只回纯文本 'Offline';改为回退 index.html 外壳。
//      ③同源 /api GET:有缓存时网络 4s 未响应先用缓存兜底(弱网不再陪网络挂到死;网络结果仍写回缓存)。
// v28: hls.min.js 换成 AAC-LC 信令补丁版(修 Chromium 138+ 播十分钟后声音低一个八度),预缓存键带 ?v=1.1.5-lc1 与页面引用一致,
//      旧版 SW 缓存(v27)里的老 hls.min.js 随 activate 清理;不带查询串的话 ignoreSearch 匹配会把老文件继续喂给页面。
// v29: Kazumi 规则源(七色番/动漫巴士)的 /api/kz/* 端点豁免(签名地址会过期,不能被策略4缓存后陈旧回放)。
// v30: 新增 libs/js/ad-clip-core.js(播放器按"分辨率突变"跳插播广告的判定核心),预缓存走 SWR。
// v31: ad-clip-core.js v2(时间戳重启/架桥信号 + 更严的片头片尾/熔断规则)。
// v32: /api/check 不走缓存(测速结论必须是这一次的)。
// v33: 用户:"一般用户刷新一下就该拿到新功能,不会去清 cookie/缓存"。
//      ① 页面(HTML)从"先回缓存、后台更新"改为【网络优先】:4s 内整页下载完就用新页面,超时/断网/服务器 5xx 才回缓存
//         (旧做法下只改 index.html 的发版,用户第一次刷新必然还是旧页面,要刷两次)。根路径导航(/?play= 等深链)统一存成 './' 外壳一份,
//         不再每条深链各存一份 600KB 的页面;/?play=(不带 _spa)可能是给微信/QQ 的分享预览页,不写外壳。sw.js 自身一律直达。
//      ② 静态库带 ?v= 版本串时先按完整 URL 找缓存:页面引用新版本(?v=3)而缓存里只有旧版本(?v=2)时走网络拿新的,
//         网络失败或 4s 等不到才回旧版本兜底(旧做法 ignoreSearch 会把旧库喂给新页面)。
//      ③ ad-clip-core.js v3:多组插播(电影天堂)+ probeTs(iOS/Safari 原生 HLS 读分片头)。
// v34: 播放前剪清单(ad-clip-core v5);/api/hls/(剪后清单托管)一律直达,不进缓存(每条都是一次性地址,缓存只会无限堆积并回放陈旧内容)。
// v35: ad-clip-core v6(剪清单时左侧未知不剪;计划缓存带核心版本)。
// v36: 站长后台/历史/设置/求片/统计/认证与带 token 的 API 一律直达不缓存(升版同时清掉旧缓存里已存的这些响应)。
// v37: Web Push 更新提醒(push / notificationclick);收藏 /api/favorites* 与推送 /api/push/* 一律直达不缓存。
// v38: pushsubscriptionchange(浏览器轮换/作废订阅时用原来的选项重新订阅,并通知已打开的页面立刻把新地址报给服务器)。
// v39: 预缓存 libs/js/qrcode-generator.min.js?v=2.0.4(截帧分享卡片的二维码库;页面首次用到才按需加载,预缓存让它走 SWR、断网也能生成)。
const CACHE_VERSION = 'v39';
const STATIC_CACHE = 'donggua-static-' + CACHE_VERSION;
const IMAGE_CACHE = 'donggua-images-' + CACHE_VERSION;
const LIVE_IMG_CACHE = 'donggua-live-img-' + CACHE_VERSION;   // 📺 直播台标(跨域，多域名)
const MAX_LIVE_IMG = 600;

// 静态资源（应用核心文件）
const STATIC_URLS = [
    './',
    './index.html',
    './manifest.json',
    './icon.png',
    './libs/css/bootstrap.min.css',
    './libs/css/animate.min.css',
    './libs/css/fontawesome.min.css',
    './libs/js/vue.global.prod.min.js',
    './libs/js/bootstrap.bundle.min.js',
    './libs/js/hls.min.js?v=1.1.5-lc1',
    './libs/js/kz-titlematch.js?v=1',   // v29: defer 脚本必须预缓存走 SWR,否则弱网下 Network-First 会拖住其后的 DPlayer/DOMContentLoaded
    './libs/js/ad-clip-core.js?v=6',    // v30: 同上(defer);v31: 判定核心 v2(加时间戳信号);v33: v4(多组插播 + probeTs);v34: v5(播放前剪清单);v35: v6
    './libs/js/ad-filter.js?v=4.0',     // v33: 与页面引用同一个 ?v=(静态库改为先按完整 URL 匹配)
    './libs/js/qrcode-generator.min.js?v=2.0.4',   // v39: 截帧分享的二维码库(按需加载;?v= 与 index.html 的 _loadQrLib 一致)
    './libs/js/DPlayer.min.js'
];

// 图片缓存配置
const IMAGE_HOSTS = [
    'image.tmdb.org',
    'i.tmdb.org'
];

// 图片缓存最大数量（防止缓存无限增长）
// 500张缓存估算占用 30MB 空间
const MAX_IMAGE_CACHE = 500;

self.addEventListener('install', event => {
    // console.log('[SW] Installing v17...');
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => {
                // console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_URLS);
            })
    );
    // 强制立即激活新版本，不等待旧版本关闭
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    // console.log('[SW] Activating v17...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // 删除所有旧版本缓存
                    if (cacheName !== STATIC_CACHE && cacheName !== IMAGE_CACHE && cacheName !== LIVE_IMG_CACHE) {
                        // console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 🚫 硬豁免(必须放在所有策略之前)：以下请求 SW 一律不碰，交给浏览器直连。
    //    ① 媒体流：video/audio 目标或带 Range 头 —— 分片响应是 206，Cache API 的 put() 遇 206 会抛异常，
    //       一旦被任何缓存策略接手，整条播放链就废掉(v27 事故根因)。
    //    ② 任何 CORS/去广告代理请求：形如 `<代理域>/?url=<真实地址>`。旧版只按 'workers.dev' 域名豁免，
    //       用户改用自定义域名(cors.ednovas.video)后完全失效，且其 pathname 恰是 '/' 会命中"HTML 页面"策略。
    //       改为按 ?url= 参数特征识别，与域名无关。
    //    ③ 跨域请求：除已在下方显式处理的图片(策略1/1b)外，一律不拦(m3u8/ts/第三方 API 都在此列)。
    const _dest = event.request.destination;
    if (_dest === 'video' || _dest === 'audio' || event.request.headers.has('range')) return;
    if (url.searchParams.has('url')) return;
    if (url.hostname.includes('workers.dev')) return;
    // ④ Kazumi 规则源端点(/api/kz/…):解析结果/清单/302 直链都带签名、会过期,必须每次直达服务器(v29)
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/kz/')) return;
    // ⑤ 站点测速 /api/check:探测结果不能被策略4缓存、在 4s 竞速/断网时陈旧回放(会吞掉 transient、把超时写成 12h 死亡记录)(v32)
    if (url.origin === self.location.origin && url.pathname === '/api/check') return;
    // ⑥ sw.js 自己(含 ?check= 之类的探测):永远直达服务器,绝不进缓存(v33)
    if (url.origin === self.location.origin && url.pathname === '/sw.js') return;
    // ⑦ 剪掉插播后的清单托管 /api/hls/cut/<id>.m3u8:一次性地址,直达服务器(v34)
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/hls/')) return;
    // ⑧ 按用户/站长的数据一律直达、不进缓存(v36):站长后台接口带全站用户数据(缓存键不含 X-Admin-Token,弱网/断网会被
    //    不鉴权回放)、历史/设置/求片/统计是每个人自己的(退出登录后还留在 Cache Storage)。缓存审计 P1-1。
    //    v37:收藏(/api/favorites 与 /api/favorites/*)、推送(/api/push/*)同理;(\/|$) 让不带子路径的 /api/favorites 也算
    if (url.origin === self.location.origin && /^\/api\/(admin|requests|history|settings|stats|auth|favorites|push)(\/|$)/.test(url.pathname)) return;
    //    带 token 参数的请求(config?token=…)同理:按用户的,不缓存
    if (url.origin === self.location.origin && url.pathname.startsWith('/api/') && url.searchParams.has('token')) return;

    // 策略1：TMDB 图片 (包含官方域名和本地反代) - Cache First
    if (IMAGE_HOSTS.some(host => url.hostname.includes(host)) || url.pathname.startsWith('/api/tmdb-image')) {
        event.respondWith(handleImageRequest(event.request));
        return;
    }

    // 📺 策略1b：直播台标等【跨域图片】- Cache First(台标在 tb.zbds.top/github 等多个域，按"图片请求"统一缓存)
    if (url.origin !== self.location.origin &&
        (event.request.destination === 'image' || /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url.pathname))) {
        event.respondWith(handleLiveImage(event.request));
        return;
    }

    // 📺 策略1c：直播频道列表 - Stale-While-Revalidate(秒显缓存 + 后台更新)
    if (url.origin === self.location.origin && url.pathname === '/api/live/channels') {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache => cache.match(event.request).then(cached => {
                const net = fetch(event.request).then(r => { if (r && r.status === 200 && r.type !== 'opaque') { try { cache.put(event.request, r.clone()); } catch (e) { } } return r; }).catch(() => cached);
                return cached || net;
            }))
        );
        return;
    }

    // 策略2：HTML 页面 - 网络优先(4s,算到整页下载完)+ 缓存兜底(v33;原来是 Stale-While-Revalidate)
    //   为什么改:SWR 先回缓存 → 只改了 index.html 的发版,用户刷新一次看到的仍是旧页面(后台才更新),要再刷一次;
    //   一般用户只会刷新一下,不会清缓存。现在:网络 4s 内整页回来(且不是 5xx)就用新页面并写回缓存;超时/断网/服务器重启中(5xx)
    //   才回缓存。竞速输了的网络结果照样写回缓存,下次打开就是新的。
    // ⚠️ SPA 外壳兜底【仅限根路径导航】(/?play= 深链等):统一存/取 './' 一份(服务器对真实用户的 /?任何参数 都返回同一个 SPA);
    //    /admin、/clear-cache.html 等独立页面按自己的 URL 存取,绝不回外壳——否则在线首次访问就会被劫持成首页。
    if (url.origin === self.location.origin && (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/')) {
        event.respondWith((async () => {
            const cache = await caches.open(STATIC_CACHE);
            const isSpaRoot = event.request.mode === 'navigate' && url.pathname === '/';
            // ⚠️ /?play=…(不带 _spa)对微信/QQ/微博等内置浏览器(server.js isSocialCrawler 认它们)回的是分享预览页(跳转到 &_spa=1),
            //    不是 SPA —— 绝不能写进外壳键,否则离线/弱网时外壳变成跳转页、来回跳(审查实测)
            const mayBeSharePage = isSpaRoot && url.searchParams.has('play') && !url.searchParams.has('_spa');
            const key = isSpaRoot ? './' : event.request;
            const network = fetch(event.request).then(response => {
                // ⚠️ 只缓存完整的 200 响应:206(分片)会让 cache.put 抛异常、opaque 无法校验 —— 一律跳过
                if (response && response.status === 200 && response.type !== 'opaque' && !mayBeSharePage) {
                    try { cache.put(key, response.clone()).catch(() => { }); } catch (e) { }
                }
                return response;
            });
            const cached = isSpaRoot
                ? ((await cache.match('./')) || (await cache.match('./index.html')))
                : await cache.match(event.request);
            if (cached) {
                // 计时要算到整页下载完(~1MB):只等到响应头就交出去,弱网下页面会卡在半截,还不如用缓存
                const usable = network.then(r => {
                    if (!r || !(r.type === 'opaqueredirect' || r.status < 500)) return null;
                    if (r.type === 'opaqueredirect' || !r.body) return r;
                    return r.clone().arrayBuffer().then(() => r);
                }).catch(() => null);
                const winner = await Promise.race([
                    usable,
                    new Promise(resolve => setTimeout(() => resolve(null), 4000))
                ]);
                if (!winner) event.waitUntil(network.catch(() => { }));  // 竞速输了 / 5xx:网络结果(若是 200)仍写回缓存
                return winner || cached;
            }
            try {
                return await network;
            } catch (e) {
                return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
            }
        })());
        return;
    }

    // 策略3：静态资源 (CSS/JS/图标) - Stale-While-Revalidate
    // ⚠️ 必须按 pathname 匹配：旧写法 event.request.url.includes('./libs/...') 里绝对 URL 不含 './'，
    //    永不命中(死代码)，libs 全部落到 Network-First，弱网时核心脚本挂起=白屏。
    // ⚠️ v33:先按【完整 URL(含 ?v=)】找缓存 —— 页面引用了新版本(?v=3)而缓存里只有旧版本(?v=2)时,ignoreSearch 会把旧库
    //    喂给新页面(新页面调用旧库没有的函数)。完整 URL 未命中 → 走网络拿新版本(写回缓存);网络失败才用 ignoreSearch 找到的
    //    旧版本兜底(defer 脚本挂起会阻塞 DOMContentLoaded 把整站卡在 loader,有旧的总比白屏好)。预缓存键与页面引用的 ?v= 保持一致。
    if (url.origin === self.location.origin &&
        STATIC_URLS.some(staticUrl => staticUrl !== './' && url.pathname === staticUrl.replace(/^\./, '').split('?')[0])) {   // v28: 预缓存项可带 ?v= 版本串,比对 pathname 时剥掉
        event.respondWith((async () => {
            const cache = await caches.open(STATIC_CACHE);
            const exact = await cache.match(event.request);
            const fetchPromise = fetch(event.request).then(response => {
                if (response && response.status === 200 && response.type !== 'opaque') {
                    try { cache.put(event.request, response.clone()).catch(() => { }); } catch (e) { }   // put 抛异常绝不能炸掉响应本身
                }
                return response;
            });
            if (exact) {   // 同一版本:秒回缓存,后台更新
                event.waitUntil(fetchPromise.catch(() => { }));
                return exact;
            }
            const old = await cache.match(event.request, { ignoreSearch: true });
            if (old) {
                // 有旧版本兜底:网络最多等 4s(弱网下 defer 脚本挂起会卡住 DOMContentLoaded);等不到先用旧的,新版本照样写回缓存
                const r = await Promise.race([
                    fetchPromise.then(x => (x && x.ok) ? x : null).catch(() => null),
                    new Promise(res => setTimeout(() => res(null), 4000))
                ]);
                if (!r) event.waitUntil(fetchPromise.catch(() => { }));
                return r || old;
            }
            try {
                return await fetchPromise;
            } catch (e) {
                return new Response('', { status: 503 });   // 必须返回 Response(undefined 会让请求直接报错)
            }
        })());
        return;
    }

    // 策略4：只处理同源请求 - Network First(+弱网缓存竞速)
    // 跳过跨域请求（如 m3u8 视频流），避免 CORS 错误
    if (url.origin !== self.location.origin) {
        return; // 让浏览器直接处理跨域请求
    }

    // 跳过 POST 请求（Cache API 不支持 POST）
    if (event.request.method !== 'GET') {
        return;
    }

    // ⚠️ SSE 流(/api/search?stream=true)与显式刷新(nocache=1)不缓存不竞速：
    //    缓存整条 SSE 会在弱网被整段回放旧结果;nocache 的语义就是"要最新",被 4s 竞速回旧副本会
    //    让"刷新集数/刷新线路"静默返回昨天的数据冒充刷新成功。这两类交给浏览器直连。
    if (url.searchParams.get('stream') === 'true' || url.searchParams.has('nocache')) {
        return;
    }

    // Network-First；已有缓存副本时网络最多等 4s——弱网挂起(不 reject)原来会连缓存兜底都拿不到，
    // 现在 4s 未响应先回缓存(旧数据可用性 > 无限转圈)，网络结果照常写回缓存供下次。
    event.respondWith((async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(event.request);
        const network = fetch(event.request).then(response => {
            if (response && response.status === 200 && response.type !== 'opaque') {
                try { cache.put(event.request, response.clone()); } catch (e) { }   // put 抛异常绝不能炸掉响应本身
            }
            return response;
        });
        if (cached) {
            const winner = await Promise.race([
                network.catch(() => null),
                new Promise(resolve => setTimeout(() => resolve(null), 4000))
            ]);
            if (!winner) event.waitUntil(network.catch(() => { }));  // 竞速输了的网络结果仍写回缓存
            return winner || cached;
        }
        try {
            return await network;
        } catch (e) {
            return new Response('Network Error', { status: 503 });
        }
    })());
});

// 图片请求处理 - Cache First 策略
async function handleImageRequest(request) {
    const cache = await caches.open(IMAGE_CACHE);

    // 1. 尝试从缓存获取
    const cached = await cache.match(request);
    if (cached) {
        // console.log('[SW] Image from cache:', request.url.substring(0, 60) + '...');
        return cached;
    }

    // 2. 从网络获取并缓存
    try {
        const response = await fetch(request);
        if (response && response.status === 200) {
            // 缓存图片
            try { cache.put(request, response.clone()); } catch (e) { }
            // 清理过多的缓存
            trimImageCache(cache);
            // console.log('[SW] Image cached:', request.url.substring(0, 60) + '...');
        }
        return response;
    } catch (error) {
        // console.error('[SW] Image fetch failed:', error);
        // 返回占位图
        return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect fill="#333" width="300" height="450"/><text fill="#666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="16">加载失败</text></svg>',
            { headers: { 'Content-Type': 'image/svg+xml' } }
        );
    }
}

// 📺 直播台标(跨域)Cache First。<img> 默认 no-cors → opaque 响应，也可缓存。
async function handleLiveImage(request) {
    const cache = await caches.open(LIVE_IMG_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response && (response.status === 200 || response.type === 'opaque')) {
            try { cache.put(request, response.clone()); } catch (e) { }
            trimCache(cache, MAX_LIVE_IMG);
        }
        return response;
    } catch (e) {
        return new Response('', { status: 504 });
    }
}

// 清理过多的图片缓存
async function trimImageCache(cache) { return trimCache(cache, MAX_IMAGE_CACHE); }
async function trimCache(cache, max) {
    const keys = await cache.keys();
    if (keys.length > max) {
        const deleteCount = keys.length - max;   // FIFO 删最早的
        for (let i = 0; i < deleteCount; i++) {
            await cache.delete(keys[i]);
        }
    }
}

// 🔔 Web Push(v37):服务器发来的 payload 是 JSON {title, body, url, tag}。
//    userVisibleOnly 订阅要求每条推送都必须弹出通知(否则浏览器会显示"本站在后台更新了"并可能吊销订阅),所以解析失败也给一条兜底通知。
self.addEventListener('push', event => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) {
        try { d = { body: event.data ? event.data.text() : '' }; } catch (e2) { d = {}; }
    }
    const title = String(d.title || 'E视界');
    const opts = {
        body: String(d.body || ''),
        icon: '/icon.png',
        badge: '/icon.png',
        data: { url: safeNotifyUrl(d.url) }
    };
    // 同一部剧的多次更新合并成一条(tag 相同就替换),renotify 让替换时仍响铃/震动;没有 tag 时不能设 renotify(会抛 TypeError)
    if (d.tag) { opts.tag = String(d.tag); opts.renotify = true; }
    event.waitUntil(self.registration.showNotification(title, opts));
});

// 点通知:有已打开的本站窗口就切过去并跳到目标页(深链 ?play= / ?requests=1 由页面自己处理),否则开新窗口
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = safeNotifyUrl(event.notification.data && event.notification.data.url);
    event.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const win = wins.find(c => { try { return new URL(c.url).origin === self.location.origin; } catch (e) { return false; } });
        if (win) {
            try { await win.focus(); } catch (e) { }
            try { if (win.navigate) { await win.navigate(url); return; } } catch (e) { }   // 不受本 SW 控制的窗口 navigate 会失败 → 开新窗口
        }
        if (self.clients.openWindow) await self.clients.openWindow(url);
    })());
});

// 🔔 浏览器轮换/作废了推送订阅(v38):用原订阅的选项(同一把服务器公钥)重新订阅。SW 拿不到登录 token,
//    新地址由页面上报:通知已打开的本站页面立刻补报('dg-push-resub'),没开着的话下次打开页面时启动补报(_pushStartupSync)。
//    任何失败都吞掉(没有权限/没有旧选项时什么也不做)
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil((async () => {
        try {
            const old = event.oldSubscription;
            const key = old && old.options && old.options.applicationServerKey;
            let sub = event.newSubscription || null;
            if (!sub) {
                if (!key) return;
                sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            }
            if (!sub) return;
            const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            wins.forEach(c => { try { c.postMessage('dg-push-resub'); } catch (e) { } });
        } catch (e) { }
    })());
});

// 通知里的跳转地址只认本站(服务器只会发站内相对地址;别的一律回首页,防被利用跳外站)
function safeNotifyUrl(u) {
    try {
        const x = new URL(String(u || '/'), self.location.origin);
        return x.origin === self.location.origin ? x.href : self.location.origin + '/';
    } catch (e) { return self.location.origin + '/'; }
}

// 监听消息（可选：手动清理缓存）
self.addEventListener('message', event => {
    if (event.data === 'clearImageCache') {
        caches.delete(IMAGE_CACHE).then(() => {
            console.log('[SW] Image cache cleared');
        });
    }
});
