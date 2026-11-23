'use strict';
// [adult] Telegram 频道当片源:视频经 tg-relay(单独部署在流量不限的服务器上)中转。
//
//   ADULT_TG_RELAY     中转地址,如 https://relay.example.com(不要套 Cloudflare 代理:CDN 条款不许大量转视频)
//   ADULT_TG_SECRET    和中转的 RELAY_SECRET 同一个值(≥16 位)
//   ADULT_TG_CHANNELS  频道表,逗号分隔:用户名[:分类名][:最短秒],如 TS88158:伪娘,ntong_1:女同,TBB18V
//                      分类名决定大类(伪娘/人妖 → 同性·跨性别);不写 = 用频道名本身判
//   ADULT_TG_MIN_SEC   默认最短时长(秒,默认 180):短于它的不收(会员引流频道的预告片)
//
// 每个频道是一个"站"(key = tg_<用户名>,family = 'tg',strict 严格站、不搜索、不走 maccms 爬虫),由目录的 TG 同步
// (lib/site-catalog/tg-sync.js)按消息 id 往后拉,转成 maccms 形状的条目走同一套入库(硬过滤 / 合并 / 重扫都一样)。
//
// 不可配置的安全规则(和硬过滤同一口径,没有开关):
//   1. 配文里去掉 #标签 / 链接 / @ / 表情 / 引流话术后,剩下的正文太少 → 不收(过滤只能看文字,没文字的视频判断不了)
//   2. 频道名 / 简介命中硬过滤 → 整个频道停用并删掉已收的
//   3. 频道里命中"未成年"的帖子 ≥ 2 条且占有正文帖子的 2% 以上 → 整个频道停用并删掉已收的(停用记在 admin:tg-kill:*,目录重建也不丢)
//   命中的单条帖子照常被硬过滤拦下;被拦 / 不收的视频永远拿不到签名地址,中转也就不会去下载它。
const crypto = require('crypto');

const CH_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SIG_LEN = 24;
const PLAY_TTL = 48 * 3600;          // 播放地址有效期(秒);按整点取整,同一小时内地址不变(浏览器缓存得住)
const THUMB_EXP = 4102444800;        // 2100-01-01:封面地址要存进目录,一直有效(签名照样挡住拿中转乱拉别的消息)
const MINOR_KILL = { hits: 2, ratio: 0.02 };
const MIN_TEXT = { cjk: 4, words: 3 };

// 和 tg-relay/lib/common.js 同一份(scripts/tg-test.mjs 核对)
function sign(secret, kind, ch, id, exp) {
    return crypto.createHmac('sha256', String(secret))
        .update('tgr1|' + kind + '|' + String(ch).toLowerCase() + '|' + id + '|' + exp)
        .digest('base64url').slice(0, SIG_LEN);
}

function parseChannels(raw, minSecDefault) {
    const out = [], seen = new Set();
    for (const part of String(raw || '').split(/[,，\s]+/)) {
        // t.me 链接先剥掉(里面的 https: 会被当成分隔符)
        const bits = part.trim().replace(/^(?:https?:\/\/)?t\.me\/(?:s\/)?/i, '').split(/[:：]/).map((x) => x.trim());
        const ch = (bits[0] || '').replace(/^@/, '').replace(/[/?#].*$/, '');
        if (!CH_RE.test(ch) || seen.has(ch.toLowerCase())) continue;
        seen.add(ch.toLowerCase());
        let cls = '', minSec = minSecDefault;
        for (const b of bits.slice(1)) {
            if (/^\d{1,5}$/.test(b)) minSec = Number(b);
            else if (b) cls = b.slice(0, 30);
        }
        out.push({ ch, key: 'tg_' + ch.toLowerCase(), cls, minSec });
    }
    return out;
}

function config(env) {
    const e = env || process.env;
    const relay = String(e.ADULT_TG_RELAY || '').trim().replace(/\/+$/, '');
    const secret = String(e.ADULT_TG_SECRET || '');
    const minSec = /^\d{1,5}$/.test(String(e.ADULT_TG_MIN_SEC || '').trim()) ? Number(e.ADULT_TG_MIN_SEC) : 180;
    const channels = parseChannels(e.ADULT_TG_CHANNELS, minSec);
    const problems = [];
    if (!/^https?:\/\/[^/\s?#]+$/i.test(relay)) problems.push('ADULT_TG_RELAY 不是 http(s)://域名[:端口] 的形式');
    if (secret.length < 16) problems.push('ADULT_TG_SECRET 没设或少于 16 位');
    if (!channels.length) problems.push('ADULT_TG_CHANNELS 里没有有效的频道用户名');
    return { on: problems.length === 0, relay, secret, minSec, channels, problems };
}

// ---------- 配文整理 ----------
const HASHTAG_RE = /[#＃]([\p{L}\p{N}_]{1,30})/gu;
const LINK_RE = /(?:https?:\/\/|www\.)\S+|(?:t|telegram)\.me\/\S*|@[A-Za-z][A-Za-z0-9_]{3,}/giu;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
// 引流话术:从这里往后整段丢(会员频道的帖子常是"简介……想看完整版点击加入会员……")
const PROMO_CUT_RE = /想看完整|完整版(?:请|点|在|见|看)|点(?:击|我)(?:加入|进入|订阅|下方|链接|观看)|加入(?:会员|频道|群)|解锁(?:全部|完整|更多)|更多(?:精彩|资源|视频)(?:请|点|在|加)|订阅(?:频道|本频道)|关注(?:频道|本频道)|投稿(?:请|联系|找)|商务合作|广告合作|防失联|备用频道|频道导航|福利群|VIP群|联系(?:客服|管理)/iu;
const PROMO_LINE_RE = /^(?:频道|群组|主频道|备用|投稿|商务|客服|导航|官方|联系|关注|订阅|会员|VIP|福利)(?:[\s:：]|$)/iu;

function cleanCaption(text) {
    const t = String(text || '').normalize('NFKC');
    const tags = [];
    for (const m of t.matchAll(HASHTAG_RE)) if (tags.indexOf(m[1]) < 0 && tags.length < 20) tags.push(m[1]);
    const lines = [];
    for (const raw of t.split(/\r?\n/)) {
        let l = raw.replace(LINK_RE, ' ').replace(HASHTAG_RE, ' ').replace(EMOJI_RE, ' ');
        const cut = l.search(PROMO_CUT_RE);
        const stop = cut >= 0;
        if (stop) l = l.slice(0, cut);
        l = l.replace(/[\s　]+/g, ' ').replace(/^[\s\-—_|·•.,，。:：!！?？~～*>]+|[\s\-—_|·•,，:：*>]+$/g, '').trim();
        if (l && !PROMO_LINE_RE.test(l)) lines.push(l);
        if (stop) break;   // 引流话术后面的一般全是频道链接 / 群号
    }
    const body = lines.join('\n');
    const cjk = (body.match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length;
    const words = (body.match(/[A-Za-z]{2,}/g) || []).length;
    return { lines, body, tags, cjk, words, meaningful: cjk >= MIN_TEXT.cjk || words >= MIN_TEXT.words };
}

function titleOf(c) {
    let name = c.lines[0] || '';
    if (name.length < 6 && c.lines[1]) name = name + ' ' + c.lines[1];
    return name.slice(0, 80).trim();
}
const hms = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };
const PLAYABLE_MIME = /^video\/(?:mp4|quicktime)$/i;

// 中转 /api/list 的一条视频消息 → maccms 形状的条目(或不收的原因)。
//   counted = 有正文(要算进频道的"未成年"比例,哪怕因为太短 / 格式不对本来就不收);ok = 收
function toVod(cfg, chan, msg, className) {
    if (!msg || !(msg.id > 0)) return { ok: false, counted: false, reason: 'tg:invalid' };
    const c = cleanCaption(msg.text);
    if (!c.meaningful) return { ok: false, counted: false, reason: 'tg:notext' };
    const id = String(msg.id);
    const year = msg.date ? new Date(msg.date * 1000).getUTCFullYear() : '';
    let reason = '';
    if (!PLAYABLE_MIME.test(String(msg.mime || '')) && !/\.(mp4|m4v|mov)$/i.test(String(msg.name || ''))) reason = 'tg:mime';
    else if (!(msg.dur >= chan.minSec)) reason = 'tg:short';
    return {
        ok: !reason, counted: true, reason: reason || undefined,
        vod: {
            vod_id: id, vod_name: titleOf(c), vod_sub: '', vod_content: c.body.slice(0, 1500),
            vod_tag: c.tags.join(','), vod_class: c.tags.join(','),
            type_id: 1, type_name: className,
            vod_pic: msg.thumb ? thumbUrl(cfg, chan.ch, id) : '',
            vod_duration: hms(msg.dur), vod_time: msg.date || '', vod_year: year ? String(year) : '', vod_remarks: '',
            vod_play_from: 'tg', vod_play_url: '正片$tg://' + chan.ch + '/' + id,
        },
        clean: c,
    };
}

// ---------- 地址 ----------
function thumbUrl(cfg, ch, id) {
    return cfg.relay + '/t/' + ch + '/' + id + '.jpg?e=' + THUMB_EXP + '&s=' + sign(cfg.secret, 't', ch, id, THUMB_EXP);
}
function playUrl(cfg, ch, id, nowSec) {
    const exp = Math.ceil(((nowSec || Math.floor(Date.now() / 1000)) + PLAY_TTL) / 3600) * 3600;
    return cfg.relay + '/v/' + ch + '/' + id + '?e=' + exp + '&s=' + sign(cfg.secret, 'v', ch, id, exp);
}
const TG_EP_RE = /tg:\/\/([A-Za-z][A-Za-z0-9_]{3,31})\/([1-9]\d{0,11})/g;
// 线路的 vod_play_url 里 tg://频道/id → 签名的中转地址(给到浏览器那一刻才签)
function signPlayUrls(cfg, playUrlStr, nowSec) {
    if (!cfg || !cfg.on || typeof playUrlStr !== 'string') return playUrlStr;
    return playUrlStr.replace(TG_EP_RE, (_, ch, id) => playUrl(cfg, ch, id, nowSec));
}

// 调中转的管理接口(/api/list、/api/msg;带密钥)
async function relayGet(cfg, path, opts) {
    const o = opts || {};
    const fetchFn = o.fetch || globalThis.fetch;
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), o.timeout || 30000);
    try {
        const r = await fetchFn(cfg.relay + path, { headers: { authorization: 'Bearer ' + cfg.secret, accept: 'application/json' }, signal: ac.signal });
        let j = null;
        try { j = await r.json(); } catch (_) { j = null; }
        if (!r.ok || !j || j.ok !== true) { const e = new Error('中转 ' + r.status + ' ' + ((j && j.error) || '')); e.status = r.status; throw e; }
        return j;
    } finally { clearTimeout(tm); }
}

// 频道名(站名):去掉表情和"|国产|91…"这类后缀
function siteName(title, ch) {
    const t = String(title || '').replace(EMOJI_RE, '').split(/[|｜]/)[0].replace(/\s+/g, ' ').trim().slice(0, 16);
    return 'TG·' + (t || ch);
}

function createTg(env) {
    let cfg = config(env);
    const titles = new Map();   // key -> 频道名(同步时更新)
    const killed = new Map();   // key -> 停用原因
    return {
        config: () => cfg,
        reload(e) { cfg = config(e || env); return cfg; },
        isTgSite: (s) => !!(s && (s.family === 'tg' || /^tg_/.test(String(s.key || '')))),
        // 目录 / 闸门用的站点表(停用的频道不出现 = 线路不出、目录重扫删光)
        sites() {
            if (!cfg.on) return [];
            return cfg.channels.filter((c) => !killed.has(c.key)).map((c) => ({
                key: c.key, name: siteName(titles.get(c.key), c.ch), api: cfg.relay + '/api/list?ch=' + c.ch,
                family: 'tg', strict: true, codeTrust: false, crawl: false, search: false, backfill: false, crawlMode: 'batch',
            }));
        },
        setTitle(key, t) { if (t) titles.set(key, String(t)); },
        setKilled(key, why) { if (why) killed.set(key, String(why)); else killed.delete(key); },
        killedOf: (key) => killed.get(key) || '',
        signPlayUrls: (s, nowSec) => signPlayUrls(cfg, s, nowSec),
    };
}

module.exports = { createTg, config, parseChannels, cleanCaption, toVod, sign, thumbUrl, playUrl, signPlayUrls, siteName, hms, relayGet, MINOR_KILL, MIN_TEXT, PLAY_TTL, THUMB_EXP, CH_RE };
