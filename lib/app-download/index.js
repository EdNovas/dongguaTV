// 📱 安卓 App 下载(手机 / 电视盒子通用的 Capacitor 壳)。站长后台「App」页里开关、填下载链接(存 cache.db 的 app_settings 表,没 sqlite 只在内存)。
//   下载链接两种都行:
//     · 直接的安装包地址(…/xxx.apk):版本号在后台手填;大小启动后 HEAD 一次去问
//     · 清单地址(…/latest.json,GitHub Actions 打 tag 时往 R2 传的那种):{ version, date, size, sha256, minAndroid, url, versionUrl },
//       版本号 / 大小每 10 分钟自动读一次
//   路由:
//     GET /app            下载页(电视浏览器也能打开:没有 Vue、几乎没有脚本;二维码给手机扫)
//     GET /app.apk        302 到安装包(短,好在电视「下载器」类 App 里手输)
//     GET /api/app/latest 当前下载信息;没开时 404
//     GET /api/admin/app、POST /api/admin/app/settings  站长后台读 / 改(X-Admin-Token)
//   安装包只在 GitHub Actions 里打包签名(签名密钥在 GitHub Secrets,不放网站服务器上),这里只管链接 —— 不在后台编译。
//   后台从没保存过时的默认:设了 APP_DOWNLOAD_JSON 就用它;没设时只有 ednovas.video 自己开(官方 App 打开的就是 ednovas.video,
//   别的站推荐它等于把用户送去别人的站 —— 自建站要先在自己的 fork 里跑 Actions 打一个指向自己网址的包,再把链接填进后台)。
//   APP_DOWNLOAD_DISABLE=1 全关(后台也开不了)。
'use strict';

const OFFICIAL_JSON = 'https://storage.ednovas.org/e-show/latest/latest.json';
const OFFICIAL_HOSTS = ['ednovas.video', 'www.ednovas.video'];
const TTL = 10 * 60 * 1000;

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(n) { return n > 0 ? (n / 1048576).toFixed(1) + ' MB' : ''; }
function safeUrl(u) { return typeof u === 'string' && u.length <= 600 && /^https?:\/\/[^\s"'<>\\]+$/.test(u) ? u : ''; }
const isManifest = u => /\.json(\?|#|$)/i.test(u);

function createAppDownload(opts) {
    const axios = opts.axios;
    const env = opts.env || process.env;
    const log = opts.log || (() => { });
    const dbOf = opts.db || (() => null);                  // () => better-sqlite3 实例或 null(调用时才取)
    const adminAuthed = opts.adminAuthed || (() => false);
    const flag = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());
    const envJson = safeUrl(String(env.APP_DOWNLOAD_JSON || '').trim());
    const disabled = flag(env.APP_DOWNLOAD_DISABLE);
    let settings = null, loaded = false;                  // { enabled, link, version, at } —— null = 后台没保存过
    let cache = { at: 0, src: '', data: null, err: '' }, inflight = null;

    // ---- 设置的存取(sqlite 的 app_settings 表;第一次用到时才读) ----
    function db() { try { return dbOf(); } catch (e) { return null; } }
    function load() {
        if (loaded) return;
        const d = db();
        if (!d) return;                                    // 库还没就绪:下次再读(先按默认走)
        loaded = true;
        try {
            d.exec('CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT)');
            const r = d.prepare('SELECT v FROM app_settings WHERE k = ?').get('download');
            if (r && r.v) settings = clean(JSON.parse(r.v));
        } catch (e) { log('读设置失败:', e.message); }
    }
    function clean(x) {
        x = x || {};
        return { enabled: x.enabled !== false, link: safeUrl(String(x.link || '').trim()), version: String(x.version || '').trim().slice(0, 32), at: Number(x.at) || Date.now() };
    }
    function save(x) {
        x = x || {};
        const next = clean(Object.assign({}, x, { at: Date.now() }));
        if (String(x.link || '').trim() && !next.link) { const e = new Error('下载链接要以 http:// 或 https:// 开头,不能有空格'); e.status = 400; throw e; }
        if (next.enabled && !next.link) { const e = new Error('打开之前先填下载链接'); e.status = 400; throw e; }
        settings = next; loaded = true;
        const d = db();
        if (d) {
            try {
                d.exec('CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT)');
                d.prepare('INSERT INTO app_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('download', JSON.stringify(settings));
            } catch (e) { log('存设置失败:', e.message); }
        }
        cache = { at: 0, src: '', data: null, err: '' };
        return settings;
    }

    function hostOf(req) { return String((req && req.headers && req.headers.host) || '').split(':')[0].toLowerCase(); }
    // 这个请求所在的站推荐哪个安装包:后台设置 > APP_DOWNLOAD_JSON > ednovas.video 用官方的 > 不推荐
    function sourceFor(req) {
        if (disabled) return '';
        load();
        if (settings) return settings.enabled ? settings.link : '';
        if (envJson) return envJson;
        return OFFICIAL_HOSTS.indexOf(hostOf(req)) >= 0 ? OFFICIAL_JSON : '';
    }
    function normalize(d) {
        if (!d || typeof d !== 'object') return null;
        const url = safeUrl(d.url), versionUrl = safeUrl(d.versionUrl) || url;
        if (!url && !versionUrl) return null;
        return {
            name: typeof d.name === 'string' ? d.name.slice(0, 40) : 'E视界',
            version: typeof d.version === 'string' ? d.version.slice(0, 32) : '',
            date: typeof d.date === 'string' ? d.date.slice(0, 20) : '',
            size: Number(d.size) > 0 ? Number(d.size) : 0,
            sha256: typeof d.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(d.sha256) ? d.sha256 : '',
            minAndroid: typeof d.minAndroid === 'string' ? d.minAndroid.slice(0, 8) : '7.0',
            url: url || versionUrl,
            versionUrl
        };
    }
    // 还没取到清单 / 直接给的安装包:能给的先给
    function basic(src) {
        if (isManifest(src)) {
            const base = src.replace(/[^/]*$/, '');
            return { name: 'E视界', version: '', date: '', size: 0, sha256: '', minAndroid: '7.0', url: base + 'E-show-latest-universal.apk', versionUrl: base + 'E-show-latest-universal.apk' };
        }
        return { name: 'E视界', version: settings && settings.link === src ? settings.version : '', date: '', size: 0, sha256: '', minAndroid: '7.0', url: src, versionUrl: src };
    }
    // 清单:读 JSON;直接安装包:HEAD 一次问大小(10 分钟缓存;并发只取一次;失败保留旧的)
    function info(req) {
        const src = sourceFor(req);
        if (!src) return Promise.resolve(null);
        if (cache.data && cache.src === src && Date.now() - cache.at < TTL) return Promise.resolve(cache.data);
        if (!inflight) {
            const task = isManifest(src)
                ? axios.get(src, { timeout: 5000, maxContentLength: 64 * 1024, headers: { 'Cache-Control': 'no-cache' } }).then(r => {
                    let d = r.data;
                    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
                    const n = normalize(d);
                    if (!n) throw new Error('清单格式不对(要有 url 或 versionUrl)');
                    return n;
                })
                : axios.head(src, { timeout: 5000, maxRedirects: 5, validateStatus: s => s >= 200 && s < 400 }).then(r => {
                    const b = basic(src);
                    b.size = Number(r.headers['content-length']) || 0;
                    return b;
                });
            inflight = task.then(d => { cache = { at: Date.now(), src, data: d, err: '' }; }, e => {
                log('下载信息取不到:', e.message);
                cache = { at: Date.now() - TTL + 60 * 1000, src, data: cache.src === src ? cache.data : null, err: e.message };   // 1 分钟后再试
            }).then(() => { inflight = null; });
        }
        return inflight.then(() => (cache.src === src && cache.data) ? cache.data : basic(src));
    }
    // /api/config 里带一份(同步,用上次取到的;还没取到就只说"有")
    function configField(req) {
        const src = sourceFor(req);
        if (!src) return null;
        if (!cache.data || cache.src !== src || Date.now() - cache.at > TTL) info(req).catch(() => { });
        const d = cache.src === src && cache.data ? cache.data : basic(src);
        return { page: '/app', version: d.version, size: d.size, minAndroid: d.minAndroid };
    }
    // 后台看的状态
    function adminState(req) {
        load();
        const src = sourceFor(req);
        return info(req).then(d => ({
            disabledByEnv: disabled,
            saved: !!settings,
            settings: settings ? { enabled: settings.enabled, link: settings.link, version: settings.version } : { enabled: !!src, link: src, version: '' },
            defaultSource: settings ? '' : (envJson ? 'env' : (src ? 'official' : '')),
            source: src,
            info: d,
            error: cache.src === src ? cache.err : '',
            officialJson: OFFICIAL_JSON,
            dbOk: !!db()
        }));
    }

    // ---- 「添加到桌面」教程的示意图(内联 SVG,不依赖外部图片;是示意不是截图,各版本系统的按钮位置略有不同) ----
    // 手机外框 + 屏幕里的内容(inner);红圈标出要点的地方
    function phone(inner) {
        return '<svg class="ill" viewBox="0 0 160 280" xmlns="http://www.w3.org/2000/svg" role="img">' +
            '<rect x="4" y="4" width="152" height="272" rx="22" fill="#2a2a33"/>' +
            '<rect x="12" y="14" width="136" height="252" rx="14" fill="#101014"/>' + inner + '</svg>';
    }
    const RING = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff3b3f" stroke-width="3"/>`;
    const PAGE = '<rect x="22" y="44" width="116" height="40" rx="6" fill="#26262e"/><rect x="22" y="92" width="54" height="72" rx="6" fill="#26262e"/><rect x="84" y="92" width="54" height="72" rx="6" fill="#26262e"/>';
    // Safari ①:底部工具栏,「分享」(方框 + 上箭头;新版 iOS 收在「⋯」里)
    const SAFARI_1 = phone(PAGE +
        '<rect x="12" y="222" width="136" height="44" rx="0" fill="#1d1d24"/><rect x="30" y="200" width="100" height="16" rx="8" fill="#2f2f38"/>' +
        '<text x="80" y="212" font-size="9" fill="#9a9aa3" text-anchor="middle">ednovas.video</text>' +
        '<path d="M30 244 l-6 -6 l6 -6" stroke="#9a9aa3" stroke-width="2" fill="none"/>' +
        '<rect x="72" y="238" width="16" height="16" rx="3" fill="none" stroke="#4da3ff" stroke-width="2"/><path d="M80 246 v-14 M75 237 l5 -5 l5 5" stroke="#4da3ff" stroke-width="2" fill="none"/>' +
        '<circle cx="118" cy="246" r="2" fill="#9a9aa3"/><circle cx="125" cy="246" r="2" fill="#9a9aa3"/><circle cx="132" cy="246" r="2" fill="#9a9aa3"/>' +
        RING(80, 244, 15) + RING(125, 246, 11));
    // Safari ②:分享面板里的「添加到主屏幕」
    const SAFARI_2 = phone('<rect x="12" y="104" width="136" height="162" rx="14" fill="#1f1f26"/>' +
        '<rect x="22" y="118" width="116" height="24" rx="6" fill="#2a2a33"/><text x="32" y="134" font-size="10" fill="#c9c9d0">拷贝</text>' +
        '<rect x="22" y="148" width="116" height="24" rx="6" fill="#2a2a33"/><text x="32" y="164" font-size="10" fill="#c9c9d0">添加到书签</text>' +
        '<rect x="22" y="178" width="116" height="24" rx="6" fill="#3a1517" stroke="#ff3b3f" stroke-width="2"/><text x="32" y="194" font-size="10" fill="#fff" font-weight="700">添加到主屏幕</text>' +
        '<rect x="118" y="184" width="12" height="12" rx="3" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M124 187 v6 M121 190 h6" stroke="#fff" stroke-width="1.5"/>' +
        '<rect x="22" y="208" width="116" height="24" rx="6" fill="#2a2a33"/><text x="32" y="224" font-size="10" fill="#c9c9d0">打印</text>');
    // Chrome ①:右上角「⋮」
    const CHROME_1 = phone('<rect x="12" y="14" width="136" height="30" fill="#1d1d24"/><rect x="20" y="21" width="100" height="16" rx="8" fill="#2f2f38"/>' +
        '<text x="70" y="33" font-size="9" fill="#9a9aa3" text-anchor="middle">ednovas.video</text>' +
        '<circle cx="137" cy="23" r="2" fill="#fff"/><circle cx="137" cy="29" r="2" fill="#fff"/><circle cx="137" cy="35" r="2" fill="#fff"/>' +
        RING(137, 29, 11) + PAGE.replace(/y="44"/, 'y="54"').replace(/y="92"/g, 'y="102"'));
    // Chrome ②:菜单里的「添加到主屏幕」/「安装应用」
    const CHROME_2 = phone('<rect x="12" y="14" width="136" height="30" fill="#1d1d24"/>' +
        '<rect x="50" y="30" width="94" height="150" rx="8" fill="#2a2a33"/>' +
        '<text x="60" y="52" font-size="10" fill="#c9c9d0">新标签页</text><text x="60" y="76" font-size="10" fill="#c9c9d0">历史记录</text><text x="60" y="100" font-size="10" fill="#c9c9d0">书签</text>' +
        '<rect x="54" y="110" width="86" height="24" rx="5" fill="#3a1517" stroke="#ff3b3f" stroke-width="2"/><text x="60" y="126" font-size="10" fill="#fff" font-weight="700">添加到主屏幕</text>' +
        '<text x="60" y="152" font-size="10" fill="#c9c9d0">设置</text><text x="60" y="172" font-size="9" fill="#9a9aa3">(有的版本叫「安装应用」)</text>');

    // 下载页:按设备分块说清楚 —— 安卓手机 / 平板、安卓电视 / 盒子下载 APK;iPhone / iPad、Apple TV 暂时没有 App(用浏览器 / AirPlay);
    // 其它智能电视、电脑用浏览器。iPhone 打开时把苹果那两块挪到最上面。页面只用老内核认识的写法,电视浏览器也能看
    function page(req, d) {
        const host = hostOf(req);
        const origin = (req.protocol === 'http' && !req.headers['x-forwarded-proto'] ? 'http' : 'https') + '://' + host;
        const href = d.versionUrl || d.url;
        const meta = [d.version, fmtSize(d.size), d.date ? d.date + ' 更新' : ''].filter(Boolean).join(' · ');
        const minA = esc(d.minAndroid || '7.0');
        const btn = `<a class="dl" href="${esc(href)}">下载安卓 App${meta ? '<small>' + esc(meta) + '</small>' : ''}</a>`;
        return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>下载 E视界 App</title>
<meta name="description" content="E视界安卓 App:手机、平板、安卓电视 / 电视盒子通用。iPhone、iPad、Apple TV 暂时没有 App,请用浏览器观看。">
<link rel="icon" href="/icon.png">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<style>
body{margin:0;background:#0e0e11;color:#f2f2f4;font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;line-height:1.7}
.w{max-width:820px;margin:0 auto;padding:32px 18px 48px}
.hd{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;margin-bottom:22px}
.hd img{width:60px;height:60px;border-radius:14px;margin-right:16px}
h1{font-size:26px;margin:0}
.sub{color:#9a9aa3;font-size:15px}
.list{display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column}
.box{background:#17171c;border-radius:14px;padding:18px 20px;margin-bottom:14px}
.box h2{font-size:19px;margin:0 0 6px}
.box h2 .tag{font-size:13px;font-weight:400;padding:2px 8px;border-radius:6px;margin-left:8px;vertical-align:middle;background:#14532d;color:#86efac}
.box h2 .tag.no{background:#3f1d1d;color:#fca5a5}
.box p{margin:4px 0;color:#c9c9d0;font-size:15px}
.box ol,.box ul{margin:6px 0 0;padding-left:20px;color:#c9c9d0;font-size:15px}
.dl{display:inline-block;margin:10px 0 4px;padding:12px 26px;border-radius:12px;background:#e50914;color:#fff;font-size:18px;font-weight:700;text-decoration:none}
.dl small{font-weight:400;font-size:13px;margin-left:10px;opacity:.85}
.dl:focus,.dl:hover{outline:3px solid #fff}
.row{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-flex-wrap:wrap;flex-wrap:wrap}
.row .txt{-webkit-flex:1 1 300px;flex:1 1 300px}
.qr{width:150px;height:150px;background:#fff;border-radius:10px;padding:7px;margin:6px 0 0 16px;box-sizing:border-box}
.qr img{width:100%;height:100%;display:block}
code{background:#26262e;padding:1px 6px;border-radius:4px;color:#ffd36b}
.note{color:#9a9aa3;font-size:13px}
.ft{color:#6d6d78;font-size:13px;margin-top:20px}
.ft a{color:#9a9aa3}
.is-apple .apple{-webkit-order:-1;order:-1}
.lk{color:#ff8a8a}
.why{background:#101014;border-radius:10px;padding:10px 14px;margin:10px 0}
.why b{font-size:15px}
.how{display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;margin-top:6px}
.col{-webkit-flex:1 1 320px;flex:1 1 320px;margin:6px 14px 6px 0}
.col h3{font-size:16px;margin:6px 0}
.ills{display:-webkit-flex;display:flex}
.ill{width:46%;max-width:150px;height:auto;margin-right:10px}
</style></head><body><div class="w">
<div class="hd"><img src="/icon.png" alt=""><div><h1>下载 E视界</h1><div class="sub">安卓手机、平板、安卓电视 / 盒子装 App;苹果设备和其它电视用浏览器看</div></div></div>
<div class="list">

<div class="box android"><div class="row"><div class="txt">
<h2>📱 安卓手机 / 平板 <span class="tag">有 App</span></h2>
<p>需要 Android ${minA} 及以上。下载后点开安装,第一次装要在系统设置里允许「安装未知来源应用」。</p>
${btn}
<div class="note">也可以用别的手机扫右边的码,打开这个下载页</div>
</div><div class="qr" id="qr"></div></div></div>

<div class="box android"><h2>📺 安卓电视 / 电视盒子 <span class="tag">有 App</span></h2>
<p>同一个安装包(Android ${minA} 及以上,小米盒子、当贝、斐讯 T1 这类老盒子都能用),打开后自动进入电视版,遥控器操作:方向键选、OK 确定、返回键退一层。</p>
<ol>
<li>盒子自带浏览器打开 <code>${esc(host)}/app</code>,点「下载安卓 App」</li>
<li>装了「下载器」类 App 的,直接输入 <code>${esc(host)}/app.apk</code></li>
<li>或者在手机上下载,再用 U 盘 / 当贝助手之类的工具传到盒子上安装</li>
</ol>
${btn}</div>

<div class="box apple"><h2>🍎 iPhone / iPad <span class="tag no">暂时没有 App</span></h2>
<p>请用浏览器观看:Safari 打开 <code>${esc(host)}</code> 就能看。想像 App 一样从桌面一点就开,看下面的「添加到桌面」。</p></div>

<div class="box apple"><h2>📺 Apple TV <span class="tag no">暂时没有 App</span></h2>
<p>Apple TV 上没有浏览器,也还没有 App。可以在 iPhone / iPad / Mac 的 Safari 里打开网站播放,再点播放器的投屏(AirPlay)投到 Apple TV。</p></div>

<div class="box apple" id="pin"><h2>📌 添加到桌面 <span class="tag">不用装 App,苹果也能用</span></h2>
<p>先在浏览器里打开网站首页 <a class="lk" href="/">${esc(host)}</a>(在首页添加,点图标打开的才是首页),再按下面的步骤放到桌面上。</p>
<div class="why"><b>比每次在浏览器里打开好在哪:</b><ul>
<li>桌面上有图标,一点就开,不用再输网址、翻书签</li>
<li>全屏显示,没有地址栏和标签页,看剧画面更大,用起来和 App 一样</li>
<li>打开更快:网站外壳存在手机里,网不好的时候也能先打开</li>
<li>iPhone / iPad 想收「追剧更新提醒」,必须先添加到主屏幕(苹果的规定,浏览器里收不到)</li>
<li>不占存储、不用更新,打开就是最新版</li>
</ul></div>
<button type="button" id="pwa" class="dl" style="display:none;border:0;cursor:pointer">一键添加到桌面</button>
<div class="how">
<div class="col"><h3>Safari(iPhone / iPad)</h3><div class="ills">${SAFARI_1}${SAFARI_2}</div><ol>
<li>点底部的「分享」按钮(方框加向上箭头;新版 iOS 在地址栏旁的「⋯」里)</li>
<li>往下滑,选「添加到主屏幕」,打开「作为网页 App 打开」(有这个开关的话),再点右上角「添加」</li>
<li>回到桌面,点 E视界 图标打开</li>
</ol></div>
<div class="col"><h3>Chrome(安卓手机 / 平板)</h3><div class="ills">${CHROME_1}${CHROME_2}</div><ol>
<li>点右上角的「⋮」</li>
<li>选「添加到主屏幕」(有的版本叫「安装应用」),再点「安装」/「添加」</li>
<li>回到桌面,点 E视界 图标打开</li>
</ol></div>
</div>
<p class="note">示意图,不同系统版本的按钮位置略有不同。电脑上的 Chrome / Edge:点地址栏右边的「安装」小图标,或者菜单 →「投放、保存和分享」→「将页面安装为应用」。</p>
</div>

<div class="box"><h2>🖥️ 其它智能电视 / 电脑 <span class="tag no">用浏览器</span></h2>
<p>三星、LG 等非安卓电视,以及 Windows / Mac 电脑:用浏览器打开 <code>${esc(host)}</code>。电视浏览器会自动进入电视版(遥控器操作);也可以直接打开 <code>${esc(host)}/tv/</code>。</p></div>

</div>
<div class="ft">${d.sha256 ? '安装包 SHA-256: <code style="word-break:break-all">' + esc(d.sha256) + '</code><br>' : ''}历史版本:<a href="https://github.com/EdNovas/e-show/releases" rel="noopener">GitHub Releases</a> · <a href="/">回到网站</a></div>
</div>
<script src="/libs/js/qrcode-generator.min.js?v=2.0.4"></script>
<script>
(function () {
  var ua = navigator.userAgent || '';
  // iPhone / iPad(iPadOS 桌面模式的 UA 是 Macintosh,靠触点数认)、Apple TV 相关:苹果那两块放最上面
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) document.body.className += ' is-apple';
  // Chrome / Edge 允许一键安装时(beforeinstallprompt)才露出「一键添加到桌面」
  var ev = null, b = document.getElementById('pwa');
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); ev = e; if (b) b.style.display = 'inline-block'; });
  if (b) b.onclick = function () { if (!ev) return; ev.prompt(); ev = null; b.style.display = 'none'; };
  try { var q = qrcode(0, 'M'); q.addData(${JSON.stringify(origin + '/app')}); q.make(); document.getElementById('qr').innerHTML = '<img alt="" src="' + q.createDataURL(6, 0) + '">'; } catch (e) { }
})();
</script>
</body></html>`;
    }

    function registerRoutes(app) {
        // 站长后台「App」页:读状态 / 改设置(开关 + 下载链接 + 版本号)
        app.get('/api/admin/app', (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            adminState(req).then(st => res.json(st), e => res.status(500).json({ error: e.message }));
        });
        app.post('/api/admin/app/settings', (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            if (disabled) return res.status(400).json({ error: '服务器设置了 APP_DOWNLOAD_DISABLE=1,下载功能已关闭' });
            try { save(req.body || {}); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
            adminState(req).then(st => res.json(st), e => res.status(500).json({ error: e.message }));
        });
        app.get('/app', (req, res, next) => {
            if (!sourceFor(req)) return next();
            info(req).then(d => {
                if (!d) return next();
                res.set('Cache-Control', 'public, max-age=300');
                res.type('html').send(page(req, d));
            }).catch(next);
        });
        app.get('/app.apk', (req, res, next) => {
            if (!sourceFor(req)) return next();
            info(req).then(d => {
                if (!d) return next();
                res.set('Cache-Control', 'no-cache');
                res.redirect(302, d.versionUrl || d.url);
            }).catch(next);
        });
        app.get('/api/app/latest', (req, res) => {
            if (!sourceFor(req)) return res.status(404).json({ enabled: false });
            info(req).then(d => {
                if (!d) return res.status(404).json({ enabled: false });
                res.set('Cache-Control', 'public, max-age=300');
                res.json(Object.assign({ enabled: true, page: '/app' }, d));
            }, () => res.status(502).json({ enabled: false }));
        });
    }

    return { registerRoutes, configField, info, adminState, save, _sourceFor: sourceFor, _normalize: normalize, _page: page };
}

module.exports = { createAppDownload, OFFICIAL_JSON };
