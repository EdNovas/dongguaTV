// Service Worker with Image Caching for dongguaTV
// v32: add the user-visible source availability scan and refresh cached HTML
const CACHE_VERSION = 'v32';
const STATIC_CACHE = 'donggua-static-' + CACHE_VERSION;
const IMAGE_CACHE = 'donggua-images-' + CACHE_VERSION;

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
                    if (cacheName !== STATIC_CACHE && cacheName !== IMAGE_CACHE) {
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

    // 策略2：HTML 页面 - Stale-While-Revalidate（秒开 + 后台更新）
    // 立即返回缓存(若有)，同时后台拉取最新版写回缓存；新版本由 index.html 的版本检测脚本 + SW 版本号兜底。
    // 相比原 Network-First：老用户不再每次重下 ~80-150KB(gzip) HTML，回访明显更快。
    if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
        event.respondWith(
            caches.open(STATIC_CACHE).then(async cache => {
                const cached = await cache.match(event.request);
                try {
                    const network = await fetch(event.request, { cache: 'no-store' });
                    if (network && network.status === 200) {
                        await cache.put(event.request, network.clone());
                    }
                    return network;
                } catch (error) {
                    return cached
                        || (await cache.match('./index.html'))
                        || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
                }
            })
        );
        return;
    }

    // 策略3：静态资源 (CSS/JS) - Stale-While-Revalidate
    // 先返回缓存，同时后台更新
    if (STATIC_URLS.some(staticUrl => event.request.url.includes(staticUrl))) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache => {
                return cache.match(event.request).then(cached => {
                    const fetchPromise = fetch(event.request).then(response => {
                        if (response && response.status === 200) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    }).catch(() => cached); // 网络失败时返回缓存
                    // 返回缓存（如果有），同时后台更新
                    return cached || fetchPromise;
                });
            })
        );
        return;
    }

    // 策略4：只处理同源请求 - Network First
    // 跳过跨域请求（如 m3u8 视频流），避免 CORS 错误
    if (url.origin !== self.location.origin) {
        return; // 让浏览器直接处理跨域请求
    }

    // 跳过 POST 请求（Cache API 不支持 POST）
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // 只缓存成功的同源 GET 请求
                if (response && response.status === 200) {
                    const responseToCache = response.clone();
                    caches.open(STATIC_CACHE).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request).then(cached => {
                    // 确保返回有效的 Response
                    return cached || new Response('Network Error', { status: 503 });
                });
            })
    );
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

// 清理过多的图片缓存
async function trimImageCache(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_IMAGE_CACHE) {
        // 删除最早的缓存（FIFO）
        const deleteCount = keys.length - MAX_IMAGE_CACHE;
        // console.log(`[SW] Trimming ${deleteCount} old cached images`);
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
