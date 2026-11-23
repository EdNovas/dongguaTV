'use strict';
// tg-relay 公用小工具:读 .env、签名地址、原子写 JSON
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// tg-relay/.env(只补没设置的变量;不依赖 dotenv)
function loadEnv(dir) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch (_) { return; }
    for (const raw of txt.replace(/^﻿/, '').split(/\r?\n/)) {
        const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || process.env[m[1]] != null) continue;
        let v = m[2];
        if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        process.env[m[1]] = v;
    }
}

// 签名地址:/v/<频道>/<消息id>?e=<到期,秒>&s=<签名>(v = 视频,t = 封面)。
// 成人站那边 lib/adult/tg.js 有同一份算法,scripts/tg-test.mjs 核对两边算出来一样 —— 改这里必须两边一起改。
const CH_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SIG_LEN = 24;
function sign(secret, kind, ch, id, exp) {
    return crypto.createHmac('sha256', String(secret))
        .update('tgr1|' + kind + '|' + String(ch).toLowerCase() + '|' + id + '|' + exp)
        .digest('base64url').slice(0, SIG_LEN);
}
function verify(secret, kind, ch, id, exp, s, nowSec) {
    if (!CH_RE.test(String(ch)) || !/^[1-9]\d{0,11}$/.test(String(id)) || !/^\d{9,11}$/.test(String(exp))) return false;
    if (typeof s !== 'string' || s.length !== SIG_LEN) return false;
    if (Number(exp) < nowSec) return false;
    const want = Buffer.from(sign(secret, kind, ch, id, exp));
    const got = Buffer.from(s);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function sameSecret(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; }
}
// 先写临时文件再改名;mode 0600(sessions.json 里是能直接登录账号的凭据)
function writeJson(file, data, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: mode || 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode || 0o600); } catch (_) { /* Windows 上没有权限位 */ }
}

// Range: bytes=a-b / a- / -n
function parseRange(h, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let a, b;
    if (m[1] === '') { a = Math.max(0, size - Number(m[2])); b = size - 1; }
    else { a = Number(m[1]); b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (!(a >= 0) || a > b || a >= size) return false;
    return [a, b];
}

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

module.exports = { loadEnv, sign, verify, sameSecret, readJson, writeJson, log, parseRange, CH_RE, SIG_LEN };
