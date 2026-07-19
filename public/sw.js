// Service Worker with Image Caching for dongguaTV
// v25: 直播台标(跨域图片)Cache-First 缓存 + /api/live/channels SWR(秒开)
// v26: 离线/弱网加固——①静态资源(libs)策略修复:原 './' 前缀匹配绝对 URL 永不命中(死代码),libs 全落
//      Network-First,弱网可能白屏;改按 pathname 匹配,真正 SWR。②导航兜底:带 ?play= 等查询参数的深链
//      cache.match 精确匹配不命中预缓存 './',断网只回纯文本 'Offline';改为回退 index.html 外壳。
//      ③同源 /api GET:有缓存时网络 4s 未响应先用缓存兜底(弱网不再陪网络挂到死;网络结果仍写回缓存)。
const CACHE_VERSION = 'v26';
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
    './libs/js/hls.min.js',
    './libs/js/ad-filter.js',
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

    // 跳过 CORS 代理请求（workers.dev 域名）
    // 这些请求需要直接发送，不能被 Service Worker 干扰
    if (url.hostname.includes('workers.dev')) {
        return; // 让浏览器直接处理
    }

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
                const net = fetch(event.request).then(r => { if (r && r.status === 200) cache.put(event.request, r.clone()); return r; }).catch(() => cached);
                return cached || net;
            }))
        );
        return;
    }

    // 策略2：HTML 页面 - Stale-While-Revalidate（秒开 + 后台更新）
    // 立即返回缓存(若有)，同时后台拉取最新版写回缓存；新版本由 index.html 的版本检测脚本 + SW 版本号兜底。
    // ⚠️ SPA 外壳兜底【仅限根路径导航】(/?play= 深链等)：精确缓存 miss 时,网络失败或弱网 5s 未响应才回
    //    './' 外壳(它每次访问首页都被 SWR 刷新,不陈旧)。/admin、/clear-cache.html 等独立页面绝不回外壳——
    //    否则在线首次访问就会被劫持成首页。
    if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
        event.respondWith((async () => {
            const cache = await caches.open(STATIC_CACHE);
            const cached = await cache.match(event.request);
            const network = fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    cache.put(event.request, response.clone());
                }
                return response;
            });
            if (cached) {
                event.waitUntil(network.catch(() => { }));  // 后台静默更新
                return cached;
            }
            const isSpaRoot = event.request.mode === 'navigate' && url.pathname === '/';
            const shell = isSpaRoot ? (await cache.match('./')) || (await cache.match('./index.html')) : null;
            if (shell) {
                const winner = await Promise.race([
                    network.catch(() => null),
                    new Promise(resolve => setTimeout(() => resolve(null), 5000))
                ]);
                if (!winner) event.waitUntil(network.catch(() => { }));  // 竞速输了的网络结果仍写回缓存
                return winner || shell;
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
    // ⚠️ cache.match 必须 ignoreSearch：页面以 'ad-filter.js?v=4.0' 带版本参数引用,预缓存键无查询串,
    //    精确匹配永 miss——该脚本是 defer,弱网挂起会阻塞 DOMContentLoaded 把整站卡在 loader。
    if (url.origin === self.location.origin &&
        STATIC_URLS.some(staticUrl => staticUrl !== './' && url.pathname === staticUrl.replace(/^\./, ''))) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache => {
                return cache.match(event.request, { ignoreSearch: true }).then(cached => {
                    const fetchPromise = fetch(event.request).then(response => {
                        if (response && response.status === 200) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    }).catch(() => cached || new Response('', { status: 503 })); // 必须返回 Response(undefined 会让请求直接报错)
                    // 返回缓存（如果有），同时后台更新
                    return cached || fetchPromise;
                });
            })
        );
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
            if (response && response.status === 200) {
                cache.put(event.request, response.clone());
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
            cache.put(request, response.clone());
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
            cache.put(request, response.clone());
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

// 监听消息（可选：手动清理缓存）
self.addEventListener('message', event => {
    if (event.data === 'clearImageCache') {
        caches.delete(IMAGE_CACHE).then(() => {
            console.log('[SW] Image cache cleared');
        });
    }
});
