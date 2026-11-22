'use strict';
// [adult] p4 成人站后台的少量持久状态(server.js 建,交给闸门;文件 = cache.db 旁边的 adult-admin.json,已 gitignore / dockerignore)
//   · siteOff     站长在后台停用的站(运行时覆盖;只能停用 / 撤销停用【站点表里有的】站,不能凭空加站,也不能打开 db 里 active:false 的站)
//   · blockWords  额外屏蔽词(只会更严;内置规则一条都动不了)。目录(lib/site-catalog)自己也存一份(adult_meta 'admin:block'),
//                 主线程的 lib/adult/policy 靠这里在启动时补上(两份取并集 = 宁可多拦)
//   · heatSecret  热度上报的按天盐的种子(算人数的 who = sha256(客户端网络 + HMAC(seed, UTC 日期)),设备限流键同样加这个盐);持久化 = 重启不会让同一个网络当天再算一次
// 读坏 / 读不到 = 空状态(停用表空、屏蔽词 null = 未知);写失败只告警(内存里照常生效)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createAdminState(opts) {
    const o = opts || {};
    const file = typeof o.file === 'string' && o.file ? o.file : '';
    const log = typeof o.log === 'function' ? o.log : () => { };
    let st = { v: 1, siteOff: {}, blockWords: null, heatSecret: '' };
    if (file) {
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (j && typeof j === 'object' && !Array.isArray(j)) {
                if (j.siteOff && typeof j.siteOff === 'object' && !Array.isArray(j.siteOff)) {
                    for (const k of Object.keys(j.siteOff)) if (typeof k === 'string' && k.length <= 64) st.siteOff[k] = Number(j.siteOff[k]) || 1;
                }
                // 和 PUT block-words / policy.setExtraBlock 同一个口径(去首尾空白后 2..40 字、无控制字符);不合口径的词单独丢掉
                if (Array.isArray(j.blockWords)) {
                    st.blockWords = j.blockWords.filter((w) => typeof w === 'string' && !/[\u0000-\u001f\u007f]/.test(w))
                        .map((w) => w.trim()).filter((w) => { const n = [...w].length; return n >= 2 && n <= 40; }).slice(0, 500);
                }
                if (typeof j.heatSecret === 'string' && /^[0-9a-f]{64}$/.test(j.heatSecret)) st.heatSecret = j.heatSecret;
            }
        } catch (e) { if (e && e.code !== 'ENOENT') log('[adult] adult-admin.json 读不了(按空状态起): ' + e.message); }
    }
    const siteOffMap = new Map(Object.keys(st.siteOff).map((k) => [k, st.siteOff[k]]));
    function save() {
        if (!file) return false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const out = { v: 1, siteOff: Object.fromEntries(siteOffMap), blockWords: st.blockWords, heatSecret: st.heatSecret };
            const tmp = file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
            fs.renameSync(tmp, file);
            return true;
        } catch (e) { log('[adult] adult-admin.json 写入失败(内存里照常生效): ' + e.message); return false; }
    }
    return {
        file,
        siteOff: (key) => typeof key === 'string' && siteOffMap.has(key),
        siteOverrides: () => Object.fromEntries(siteOffMap),
        setSiteOff(key, off, now) {
            if (typeof key !== 'string' || !key || key.length > 64) return false;
            if (off) siteOffMap.set(key, Number(now) || Date.now()); else siteOffMap.delete(key);
            return save();
        },
        blockWords: () => (Array.isArray(st.blockWords) ? st.blockWords.slice() : null),
        setBlockWords(words) { st.blockWords = Array.isArray(words) ? words.slice(0, 500) : []; return save(); },
        heatSecret() {
            if (!st.heatSecret) { st.heatSecret = crypto.randomBytes(32).toString('hex'); save(); }
            return st.heatSecret;
        },
    };
}
module.exports = { createAdminState };
