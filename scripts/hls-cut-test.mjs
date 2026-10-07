#!/usr/bin/env node
// 剪后清单托管(lib/hls-cut)回归:node scripts/hls-cut-test.mjs
//   规范化(白名单重建/拒绝项)、存储(LRU/过期/每来源上限/幂等/占位抢注)、真实 HTTP(POST→GET、先 GET 等 POST 的占位交付、
//   等待并发上限、gzip、响应头、501 桩)、server.js / api/index.js / sw.js 接线(静态)。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = require(path.join(ROOT, 'lib/hls-cut'));
const C = require(path.join(ROOT, 'public/libs/js/ad-clip-core.js'));
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const express = dep('express');
const bodyParser = dep('body-parser');

let pass = 0, fail = 0;
const fails = [];
const ok = (c, name, extra) => { if (c) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 400) : '')); } };

const raw = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt-lxrg1.m3u8'), 'utf8');
const BASE = 'https://cdn.example/20260911/x/3000k/hls/mixed.m3u8';
const absText = C.cutPlaylist(raw, BASE, []).text;
const cutText = C.cutPlaylist(raw, BASE, [10, 11, 59, 60]).text;

console.log('[1] 规范化');
{
    const c = H.canonicalize(cutText);
    ok(c.ok && c.segs === 699 && Math.abs(c.dur - (2831.672 - 34.832)) < 0.01, '真实剪后清单通过,分片数/时长对', c.why || [c.segs, c.dur]);
    ok(/^#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:\d+\n/.test(c.text) && /#EXT-X-PLAYLIST-TYPE:VOD\n/.test(c.text) && /#EXT-X-ENDLIST\n$/.test(c.text), '重建后的头/尾');
    ok((c.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length === (cutText.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 'DISCONTINUITY 一个不少');
    const segsIn = cutText.split('\n').filter(l => l && l[0] !== '#'), segsOut = c.text.split('\n').filter(l => l && l[0] !== '#');
    ok(segsIn.length === segsOut.length && segsIn.every((u, i) => u === segsOut[i]), '分片地址原样(含查询串令牌)');
    // 规范化前后用同一个解析器分组 → 完全一致(Safari 拿到的时间轴 = 我们算的剪后时间轴)
    const g1 = C.parseMedia(cutText, BASE).groups, g2 = C.parseMedia(c.text, BASE).groups;
    ok(g1.length === g2.length && g1.every((g, i) => g.cc === g2[i].cc && Math.abs(g.start - g2[i].start) < 1e-6 && g.n === g2[i].n), '规范化不改变分组/时间轴');
    const rej = (txt, why, name) => { const r = H.canonicalize(txt); ok(!r.ok && r.why === why, name, r.why); };
    rej(raw, 'relative_or_bad_uri', '相对地址拒绝(必须交绝对地址)');
    rej(absText.replace('#EXT-X-ENDLIST', ''), 'no_endlist', '没有 ENDLIST(直播)拒绝');
    rej(absText.replace('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-PLAYLIST-TYPE:EVENT'), 'live', 'EVENT 拒绝');
    rej('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://a.b/x.m3u8\n', 'master', '主清单拒绝');
    rej(absText.replace('#EXT-X-TARGETDURATION', '#EXT-X-KEY:METHOD=AES-128,URI="https://k/k"\n#EXT-X-TARGETDURATION'), 'encrypted', '加密拒绝');
    rej(absText.replace('#EXT-X-TARGETDURATION', '#EXT-X-MAP:URI="https://a/i.mp4"\n#EXT-X-TARGETDURATION'), 'unsupported_ext-x-map', 'fMP4 拒绝');
    rej(absText.replace('#EXT-X-TARGETDURATION', '#EXT-X-DEFINE:NAME="x",VALUE="y"\n#EXT-X-TARGETDURATION'), 'unsupported_ext-x-define', '变量替换拒绝');
    rej(absText.replace(/https:\/\/cdn\.example/g, 'http://10.0.0.5'), 'private_host', '内网地址拒绝');
    rej(absText.replace(/https:\/\/cdn\.example/, 'https://u:p@cdn.example'), 'userinfo', '带账号密码的地址拒绝');
    rej(absText.replace(/https:\/\/cdn\.example/, 'javascript:alert(1)//'), 'bad_scheme', '非 http(s) 拒绝');
    rej('#EXTM3U\n#EXTINF:4,\nhttps://a.b/1.ts\n#EXTINF:4,\n#EXTINF:4,\nhttps://a.b/2.ts\n#EXT-X-ENDLIST\n', 'extinf_twice', 'EXTINF 连写拒绝');
    rej('#EXTM3U\nhttps://a.b/1.ts\n#EXT-X-ENDLIST\n', 'uri_without_extinf', '没有 EXTINF 的分片拒绝');
    rej('hello\n', 'no_extm3u', '不是清单拒绝');
    rej('#EXTM3U\n#EXTINF:4,\nhttps://a.b/1.ts\u0001\n#EXT-X-ENDLIST\n', 'control_chars', '控制字符拒绝');
    rej('#EXTM3U\n#EXT-X-ENDLIST\n', 'empty', '空清单拒绝');
    rej(absText + 'x'.repeat(2 * 1024 * 1024), 'too_large', '超过 2MB 拒绝');
    rej('#EXTM3U\n' + Array.from({ length: 2 }, (_, i) => '#EXTINF:20000,\nhttps://a.b/' + i + '.ts').join('\n') + '\n#EXT-X-ENDLIST\n', 'bad_extinf', 'EXTINF 超过 600s 拒绝');
    // 白名单外的标签丢弃(DATERANGE 可以携带 Apple 插播广告;LL-HLS/PROGRAM-DATE-TIME 等)
    const withJunk = absText.replace('#EXT-X-TARGETDURATION:8', '#EXT-X-TARGETDURATION:8\n#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",X-ASSET-URI="https://ads/x.m3u8"\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-START:TIME-OFFSET=30\n# 普通注释');
    const cj = H.canonicalize(withJunk);
    ok(cj.ok && !/DATERANGE|PROGRAM-DATE-TIME|EXT-X-KEY|EXT-X-START|注释/.test(cj.text), '白名单外标签全部丢弃(含 Apple 插播 DATERANGE)', cj.why);
    // TARGETDURATION 不能小于最长分片
    const big = H.canonicalize('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:9.6,\nhttps://a.b/1.ts\n#EXT-X-ENDLIST\n');
    ok(big.ok && /#EXT-X-TARGETDURATION:10\n/.test(big.text), 'TARGETDURATION 按最长分片向上取整修正', big.text);
    ok(H.canonicalize('﻿' + absText.replace(/\n/g, '\r\n')).ok, 'BOM + CRLF 也接受');
}

console.log('[2] 存储');
{
    let t = 1_000_000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
        const s = H.createStore({ maxEntries: 3, idleMs: 1000, hardMs: 5000, maxPerOwner: 2 });
        ok(s.put('a'.repeat(24), 'o1', 'A').ok && s.get('a'.repeat(24)), '存取');
        ok(s.put('a'.repeat(24), 'o1', 'A').ok, '同来源同内容幂等');
        ok(!s.put('a'.repeat(24), 'o2', 'X').ok, '别的来源不能覆盖已占用的 id');
        s.put('b'.repeat(24), 'o1', 'B');
        s.put('c'.repeat(24), 'o1', 'C');
        ok(!s.get('a'.repeat(24)) && s.get('b'.repeat(24)) && s.get('c'.repeat(24)), '每来源上限 2:挤掉它自己最老的');
        s.put('d'.repeat(24), 'o2', 'D'); s.put('e'.repeat(24), 'o3', 'E');
        ok(s.stats().entries <= 3, '总条数上限', s.stats());
        t += 1500;
        ok(!s.get('d'.repeat(24)), '空闲超时过期');
        s.put('f'.repeat(24), 'o4', 'F');
        for (let k = 0; k < 6; k++) { t += 900; s.get('f'.repeat(24)); }
        ok(!s.get('f'.repeat(24)), '访问续期但不超过最长存活', s.stats());
        s._close();
        const s2 = H.createStore({ maxBytes: 60 });
        s2.put('g'.repeat(24), 'x', 'x'.repeat(10)); s2.put('h'.repeat(24), 'y', 'y'.repeat(10));
        ok(s2.stats().bytes <= 60, '按压缩后字节淘汰', s2.stats());
        s2._close();
    } finally { Date.now = realNow; }
}

console.log('[3] HTTP');
const app = express();
app.use(bodyParser.json({ limit: '5mb' }));
const store = H.registerRoutes(app, { waitMs: 600, storeOpts: { maxWaiters: 3, maxWaitersPerIp: 2 }, authorize: (tok) => tok === 'banned' ? 'banned' : 'ok', ownerOf: (req, b) => 'o:' + ((b && b.who) || 'anon') });
const stubApp = express();
H.registerStub(stubApp);
const listen = (a) => new Promise(r => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
const srv = await listen(app), stub = await listen(stubApp);
const U = (p, s = srv) => 'http://127.0.0.1:' + s.address().port + p;
const post = (body, s) => fetch(U('/api/hls/cut', s), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ID = () => Buffer.from(Array.from({ length: 18 }, () => Math.floor(Math.random() * 256))).toString('base64url');
try {
    // 直接交付
    let r = await post({ m3u8: cutText });
    let j = await r.json();
    ok(r.status === 200 && /^\/api\/hls\/cut\/[A-Za-z0-9_-]{24}\.m3u8$/.test(j.url) && j.segs === 699, 'POST 不带 id → 服务器生成 id', j);
    ok(r.headers.get('cache-control') === 'no-store', 'POST 响应 no-store');
    let g = await fetch(U(j.url), { headers: { 'accept-encoding': 'identity' } });
    let body = await g.text();
    ok(g.status === 200 && /^application\/vnd\.apple\.mpegurl/.test(g.headers.get('content-type')) && body === H.canonicalize(cutText).text, 'GET 拿到规范化后的清单', [g.status, g.headers.get('content-type')]);
    ok(g.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(g.headers.get('content-security-policy') || '') && g.headers.get('cache-control') === 'no-store', 'GET 安全头');
    g = await fetch(U(j.url), { headers: { 'accept-encoding': 'gzip' } });
    ok(g.status === 200 && (await g.text()) === body, 'gzip 协商(fetch 自动解压)后内容一致');
    // 占位:先 GET(Safari),后 POST(扫描完成)
    const id = ID();
    const t0 = Date.now();
    const pending = fetch(U('/api/hls/cut/' + id + '.m3u8'));
    await new Promise(res => setTimeout(res, 200));
    r = await post({ id, m3u8: cutText, who: 'safari' });
    ok(r.status === 200 && (await r.json()).id === id, '占位 id 交付成功');
    g = await pending;
    ok(g.status === 200 && (await g.text()).includes('#EXT-X-ENDLIST') && Date.now() - t0 < 600, '先到的 GET 在交付后立刻拿到清单(没等到超时)', Date.now() - t0);
    // 别的来源抢注同一个 id
    r = await post({ id, m3u8: absText, who: 'evil' });
    ok(r.status === 409, '别的来源不能覆盖已交付的 id', r.status);
    // 没人交付 → 等到超时 404
    const t1 = Date.now();
    g = await fetch(U('/api/hls/cut/' + ID() + '.m3u8'));
    ok(g.status === 404 && Date.now() - t1 >= 550, '占位等不到交付 → 超时 404', [g.status, Date.now() - t1]);
    // 等待并发上限:同一 IP 超过 2 个挂起的 GET → 立刻 404
    const hang = [fetch(U('/api/hls/cut/' + ID() + '.m3u8')), fetch(U('/api/hls/cut/' + ID() + '.m3u8'))];
    await new Promise(res => setTimeout(res, 50));
    const t2 = Date.now();
    g = await fetch(U('/api/hls/cut/' + ID() + '.m3u8'));
    ok(g.status === 404 && Date.now() - t2 < 300, '同一 IP 挂起的等待超过上限 → 立刻 404(防挂连接)', Date.now() - t2);
    await Promise.all(hang);
    ok(store.stats().waiting === 0, '等待全部释放', store.stats());
    // 客户端断开(换集/关页)→ 立刻释放等待名额,不用等满超时
    {
        const ac = new AbortController();
        const pend = fetch(U('/api/hls/cut/' + ID() + '.m3u8'), { signal: ac.signal }).catch(() => null);
        await new Promise(res => setTimeout(res, 80));
        ok(store.stats().waiting === 1, '挂起中占 1 个名额', store.stats());
        ac.abort(); await pend;
        await new Promise(res => setTimeout(res, 80));
        ok(store.stats().waiting === 0, '客户端断开 → 名额立刻释放', store.stats());
    }
    // 坏输入
    ok((await post({ m3u8: raw })).status === 400, '相对地址清单 400');
    ok((await post({ id: 'short', m3u8: cutText })).status === 400, '坏 id 400');
    ok((await post({ token: 'banned', m3u8: cutText })).status === 403, '被封禁的令牌 403');
    ok((await fetch(U('/api/hls/cut/..%2Fsecret.m3u8'))).status === 404 && (await fetch(U('/api/hls/cut/x.m3u8'))).status === 404, '坏文件名 404');
    // 全站预算只数成功创建的:一堆坏请求不会把正常用户挤成 429
    {
        const app2 = express(); app2.use(bodyParser.json({ limit: '5mb' }));
        const st2 = H.registerRoutes(app2, { globalPerMin: 2 });
        const s2 = await listen(app2);
        for (let k = 0; k < 5; k++) await post({ m3u8: raw }, s2);   // 相对地址,全是 400
        const a1 = await post({ m3u8: cutText }, s2), a2 = await post({ m3u8: absText }, s2), a3 = await post({ m3u8: cutText.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4') }, s2);
        ok(a1.status === 200 && a2.status === 200 && a3.status === 429, '预算只数成功创建(坏请求不消耗),用完了才 429', [a1.status, a2.status, a3.status]);
        s2.close(); st2._close();
    }
    // 501 桩
    r = await post({ m3u8: cutText }, stub);
    ok(r.status === 501 && (await fetch(U('/api/hls/cut/' + ID() + '.m3u8', stub))).status === 501, '无状态后端 501 桩');
} finally {
    srv.close(); stub.close(); store._close();
}

console.log('[4] 接线(静态)');
{
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const api = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    ok(/ownerOf: \(req, body\) => 'ip:' \+ ipKey\(req\)/.test(server), '来源按 IP(+ 有效令牌):单密码站不会全站共用一个配额');
    ok(/require\('\.\/lib\/hls-cut'\)\.registerRoutes\(app/.test(server) && server.indexOf("require('./lib/hls-cut')") > server.indexOf('app.use(apiLimiter)'), 'server.js 在通用限流之后注册剪后清单路由');
    ok(/const HLS_CUT_ENABLED = !envFlag\('HLS_CUT_DISABLE'\)/.test(server), '开关走 envFlag(填 0 不会误关)');
    ok(/hls_cut: !!hlsCut/.test(server) && /hls_cut: false/.test(api), '/api/config 报告能力:VPS 看是否注册成功,Vercel 恒为 false');
    ok(/require\('\.\.\/lib\/hls-cut'\)\.registerStub\(app\)/.test(api), 'api/index.js 挂 501 桩');
    ok(/Object\.prototype\.hasOwnProperty\.call\(PASSWORD_HASH_MAP, token\)/.test(server.slice(server.indexOf('HLS_CUT_ENABLED'), server.indexOf('HLS_CUT_ENABLED') + 2000)), '令牌查表用 hasOwnProperty(constructor/__proto__ 不算有效令牌)');
    ok(!/v2board|V2B_|emax_/i.test(fs.readFileSync(path.join(ROOT, 'lib/hls-cut/index.js'), 'utf8')), 'lib/hls-cut 不含 v2board 代码(主线可同步)');
    ok(/url\.pathname\.startsWith\('\/api\/hls\/'\)\) return;/.test(sw), 'SW 不缓存 /api/hls/(剪后清单)');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.join('\n')); process.exitCode = 1; }
