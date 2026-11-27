#!/usr/bin/env node
// 安卓 App 下载(lib/app-download)回归(离线,假 axios / 假 sqlite):
//   默认开关(ednovas.video 开、别的站关、APP_DOWNLOAD_JSON / APP_DOWNLOAD_DISABLE)、后台保存的校验和落库、
//   清单 / 直接安装包两种链接、/app /app.apk /api/app/latest /api/admin/app 路由、下载页内容
//   node scripts/app-download-test.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createAppDownload, OFFICIAL_JSON } = require(path.join(ROOT, 'lib/app-download'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const MANIFEST = { name: 'E视界', version: 'v9.9.9', date: '2026-11-27', size: 5585100, sha256: 'a'.repeat(64), minAndroid: '7.0', url: 'https://cdn.example/latest.apk', versionUrl: 'https://cdn.example/v9.9.9.apk' };
function fakeAxios(calls) {
    return {
        get: async (u) => { calls.push(['get', u]); if (/bad\.json/.test(u)) throw new Error('404'); return { data: JSON.stringify(MANIFEST) }; },
        head: async (u) => { calls.push(['head', u]); return { headers: { 'content-length': '1234567' } }; }
    };
}
function fakeDb() {
    const rows = {};
    return {
        rows,
        exec() { },
        prepare(sql) {
            return {
                get: (k) => rows[k] ? { v: rows[k] } : undefined,
                run: (k, v) => { rows[k] = v; }
            };
        }
    };
}
const req = (host) => ({ headers: { host }, protocol: 'https' });
function mkApp() {
    const routes = {};
    return { routes, get(p, ...h) { routes['GET ' + p] = h[h.length - 1]; }, post(p, ...h) { routes['POST ' + p] = h[h.length - 1]; } };
}
function call(app, key, rq) {
    return new Promise((resolve) => {
        const res = {
            code: 200, headers: {}, body: null,
            set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; },
            json(b) { this.body = b; resolve(this); }, type() { return this; }, send(b) { this.body = b; resolve(this); },
            redirect(c, u) { this.code = c; this.body = u; resolve(this); }
        };
        app.routes[key](rq, res, () => { res.code = 404; resolve(res); });
    });
}

console.log('① 默认开关');
{
    const calls = [];
    const a = createAppDownload({ axios: fakeAxios(calls), env: {} });
    ok(a._sourceFor(req('ednovas.video')) === OFFICIAL_JSON, 'ednovas.video 默认用官方清单');
    ok(a._sourceFor(req('e.show')) === OFFICIAL_JSON && a._sourceFor(req('www.e.show')) === OFFICIAL_JSON, 'e.show(同一个网站的另一个域名)也默认用官方清单');
    ok(a._sourceFor(req('example.com')) === '', '别的站默认不推荐(官方 App 打开的是 ednovas.video)');
    ok(a.configField(req('example.com')) === null, '…/api/config 的 app_download 为 null');
    const b = createAppDownload({ axios: fakeAxios(calls), env: { APP_DOWNLOAD_JSON: 'https://my.site/app/latest.json' } });
    ok(b._sourceFor(req('example.com')) === 'https://my.site/app/latest.json', 'APP_DOWNLOAD_JSON 指定清单');
    const c = createAppDownload({ axios: fakeAxios(calls), env: { APP_DOWNLOAD_DISABLE: '1' } });
    ok(c._sourceFor(req('ednovas.video')) === '', 'APP_DOWNLOAD_DISABLE=1 全关');
    ok(createAppDownload({ axios: fakeAxios(calls), env: { APP_DOWNLOAD_JSON: 'javascript:alert(1)' } })._sourceFor(req('x.com')) === '', '环境变量里的非 http 链接不认');
}

console.log('② 后台保存');
{
    const calls = [], db = fakeDb();
    const a = createAppDownload({ axios: fakeAxios(calls), env: {}, db: () => db, adminAuthed: () => true });
    let err = null;
    try { a.save({ enabled: true, link: 'javascript:alert(1)' }); } catch (e) { err = e; }
    ok(err && err.status === 400, '非 http 链接拒收');
    err = null;
    try { a.save({ enabled: true, link: '' }); } catch (e) { err = e; }
    ok(err && err.status === 400, '打开但没填链接拒收');
    a.save({ enabled: true, link: 'https://dl.my.site/e-show.apk', version: 'v1.2.3' });
    ok(a._sourceFor(req('example.com')) === 'https://dl.my.site/e-show.apk', '保存后任何站都按后台的链接');
    ok(JSON.parse(db.rows.download).link === 'https://dl.my.site/e-show.apk', '落库 app_settings.download');
    const again = createAppDownload({ axios: fakeAxios(calls), env: {}, db: () => db });
    ok(again._sourceFor(req('example.com')) === 'https://dl.my.site/e-show.apk', '重启后从库里读回来');
    a.save({ enabled: false, link: 'https://dl.my.site/e-show.apk' });
    ok(a._sourceFor(req('ednovas.video')) === '', '后台关掉后连 ednovas.video 也不推荐');
}

console.log('③ 下载信息 + 路由');
{
    const calls = [], db = fakeDb();
    const a = createAppDownload({ axios: fakeAxios(calls), env: {}, db: () => db, adminAuthed: (r) => r.headers['x-admin-token'] === 't' });
    const app = mkApp();
    a.registerRoutes(app);
    for (const k of ['GET /app', 'GET /app.apk', 'GET /api/app/latest', 'GET /api/admin/app', 'POST /api/admin/app/settings']) ok(!!app.routes[k], '注册了 ' + k);
    let r = await call(app, 'GET /app', req('example.com'));
    ok(r.code === 404, '没开时 /app 交给下一个(404)');
    r = await call(app, 'GET /api/admin/app', req('example.com'));
    ok(r.code === 403, '后台接口要 X-Admin-Token');
    r = await call(app, 'POST /api/admin/app/settings', Object.assign(req('example.com'), { headers: { host: 'example.com', 'x-admin-token': 't' }, body: { enabled: true, link: 'https://cdn.example/latest.json' } }));
    ok(r.code === 200 && r.body.saved && r.body.info && r.body.info.version === 'v9.9.9', '保存清单链接 → 读到版本号', r.body);
    r = await call(app, 'GET /app.apk', req('example.com'));
    ok(r.code === 302 && r.body === MANIFEST.versionUrl, '/app.apk 跳到带版本号的安装包', r.body);
    r = await call(app, 'GET /app', req('example.com'));
    ok(r.code === 200 && /iPhone \/ iPad/.test(r.body) && /Apple TV/.test(r.body) && /添加到主屏幕/.test(r.body) && /v9\.9\.9/.test(r.body), '下载页:安卓 / 苹果 / 添加到桌面 / 版本号都在');
    ok(!/<script[^>]*>[^<]*=>/.test(r.body), '下载页内联脚本不用箭头函数(电视浏览器)');
    const cf = a.configField(req('example.com'));
    ok(cf && cf.page === '/app' && cf.version === 'v9.9.9', '/api/config 带 app_download', cf);
    r = await call(app, 'POST /api/admin/app/settings', { headers: { host: 'example.com', 'x-admin-token': 't' }, body: { enabled: true, link: 'https://cdn.example/x.apk', version: 'v2' } });
    ok(r.body.info && r.body.info.url === 'https://cdn.example/x.apk' && r.body.info.size === 1234567 && r.body.info.version === 'v2', '直接安装包:HEAD 取大小、版本号用后台填的', r.body.info);
    r = await call(app, 'POST /api/admin/app/settings', { headers: { host: 'example.com', 'x-admin-token': 't' }, body: { enabled: true, link: 'https://cdn.example/bad.json' } });
    ok(r.body.error && /404/.test(r.body.error) && r.body.info, '清单取不到:报错给后台,页面仍给固定 latest 地址', r.body);
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
