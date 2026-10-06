// 资源站档案(广告档位 / 分辨率 / 海外受限):前端线路列表的徽章与自动选源偏好都靠它。
//
// 公共 API(server.js 与 api/index.js 共用同一模块,与 lib/kazumi 同理——两后端手抄必漂移):
//   profileFor(site)   → {tier, res, geo, note, codec}   tier ∈ clean|noburn|insert|unknown|ads(查不到/写错一律 'unknown')
//                                                 res ∈ '4k'|'1080p'|'720p'|'sd'|''   geo:boolean   note:string
//                                                 codec ∈ 'hevc'|''(''=H.264/未知;前端据此判断本机能否解码再决定要不要提档)
//                                                 clip:boolean = 插播里有"清单上分不出、只能靠播放器按分辨率突变跳"的段
//                                                   (如意:棋牌中插切成和正片一样的块),前端在跳不了的设备上(iOS/Safari 原生 HLS)按"有插播"显示
//   profileMap(sites)  → {[site.key]: profileFor(site)}   同 key 只取第一个(与 allSites 合并时 db.json 优先同序)
//   hostOf(api)        → 小写域名,去掉开头的 www.(查不出返回 '')
//   version            → profiles.json 的数据版本(审计日期),前端可据此判断本地缓存是否过期
//
// 查找顺序:内置 Kazumi 规则站(kazumi:true,无 API 域名)查 keys[site.key];其余按 API 域名查 hosts。
//   为什么不按 key 查 maccms 站:各家 db.json 的 key 是自己起的名字,同一个站在不同部署里 key 不同,域名才稳定;
//   反过来 db.json 里与内置规则站同 key 的条目是普通 maccms 站(见 lib/kazumi isKzSite 注释),不能套用 kz 档案。
// db.json 逐站覆盖(生产环境改一个站不用发版):
//   "profile": {"tier":"ads","res":"720p","geo":0,"note":"…","codec":"hevc","clip":1}   也认短字段 t/r/geo/n/c,只覆盖写了的字段
//   "ad_tier": "clean"                                            档位简写,在 profile 之后生效;也认 无广告/无硬广/未评测/含广告
// 档案只是一次抽样审计的结论(片内博彩横幅可能只在 15-19 分钟出现),它只影响徽章和"同一可达档内"的偏好,
// 绝不能拿来否决可达性——那是前端测速的事。
'use strict';

// 静态 require:Vercel nft 才能把 json 打进函数包。数据坏了只丢徽章,模块本身照常导出(调用方另有 try/catch 兜底)
let DATA = null;
try { DATA = require('./profiles.json'); } catch (e) { console.warn('[SiteProfiles] profiles.json 加载失败,徽章全部显示未评测:', e.message); }
if (!DATA || typeof DATA !== 'object') DATA = {};
const HOSTS = (DATA.hosts && typeof DATA.hosts === 'object') ? DATA.hosts : {};
const KEYS = (DATA.keys && typeof DATA.keys === 'object') ? DATA.keys : {};
const version = typeof DATA.version === 'string' ? DATA.version : '';

// insert = 画面干净但插播去不掉(去广告 worker 也删不掉的插片);前端在 worker 不在播放链路时也会把 noburn 降成它
const TIERS = ['clean', 'noburn', 'insert', 'unknown', 'ads'];
// db.json 由站长手写,中文标签也认,省得记英文 id(前端显示名:无广告/有插播/未评测/有水印;旧名 无硬广/含广告 照认)
const TIER_ALIAS = { '无广告': 'clean', '无硬广': 'noburn', '插播已去除': 'noburn', '有插播': 'insert', '未评测': 'unknown', '含广告': 'ads', '有水印': 'ads' };
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);   // "constructor" 之类原型键不算命中

function normTier(v) {
    const s = String(v == null ? '' : v).trim();
    if (own(TIER_ALIAS, s)) return TIER_ALIAS[s];
    const l = s.toLowerCase();
    return TIERS.indexOf(l) >= 0 ? l : 'unknown';
}
function normRes(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    if (/^(4k|uhd|2160p?)$/.test(s)) return '4k';
    if (/^(1080p?|fhd|蓝光|超清)$/.test(s)) return '1080p';
    if (/^(720p?|hd|高清)$/.test(s)) return '720p';
    if (/^(sd|标清|\d{3}p?)$/.test(s)) return 'sd';   // 480p/540p/486 之类一律算标清
    return '';
}
function normGeo(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
// HEVC 单独标出来:很多浏览器(Firefox、不少 Linux/Android Chrome、无硬解的旧 Windows)MSE 解不了 H.265,
//   前端不能把这种源当"无广告首选"自动起播(可能黑屏只有声音、也不报错,自动换源都不触发)
function normCodec(v) { return /^(hevc|h.?265|hvc1|hev1)$/i.test(String(v == null ? '' : v).trim()) ? 'hevc' : ''; }
function normClip(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
function normNote(v) { return typeof v === 'string' ? v.trim().slice(0, 120) : ''; }

function hostOf(api) {
    const s = String(api || '').trim();
    if (!s) return '';
    let h = '';
    try { h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s).hostname; } catch (e) { return ''; }
    return h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// 把一条原始记录(短字段 t/r/geo/n 或长字段 tier/res/geo/note)按"写了才覆盖"合并进 out
function applyRaw(out, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (own(raw, 'tier')) out.tier = normTier(raw.tier); else if (own(raw, 't')) out.tier = normTier(raw.t);
    if (own(raw, 'res')) out.res = normRes(raw.res); else if (own(raw, 'r')) out.res = normRes(raw.r);
    if (own(raw, 'geo')) out.geo = normGeo(raw.geo);
    if (own(raw, 'note')) out.note = normNote(raw.note); else if (own(raw, 'n')) out.note = normNote(raw.n);
    if (own(raw, 'codec')) out.codec = normCodec(raw.codec); else if (own(raw, 'c')) out.codec = normCodec(raw.c);
    if (own(raw, 'clip')) out.clip = normClip(raw.clip);
}

function profileFor(site) {
    const out = { tier: 'unknown', res: '', geo: false, note: '', codec: '', clip: false };
    if (!site || typeof site !== 'object') return out;
    const key = typeof site.key === 'string' ? site.key : '';
    if (site.kazumi === true) { if (own(KEYS, key)) applyRaw(out, KEYS[key]); }
    else { const h = hostOf(site.api); if (h && own(HOSTS, h)) applyRaw(out, HOSTS[h]); }
    // db.json 覆盖层:profile 对象 → ad_tier 简写
    if (site.profile && typeof site.profile === 'object') applyRaw(out, site.profile);
    if (site.ad_tier != null && site.ad_tier !== '') out.tier = normTier(site.ad_tier);
    return out;
}

function profileMap(sites) {
    const map = Object.create(null);   // key 是站长填的任意字符串,"__proto__" 也不能改到原型上
    (Array.isArray(sites) ? sites : []).forEach((s) => {
        if (!s || typeof s.key !== 'string' || !s.key || own(map, s.key)) return;
        map[s.key] = profileFor(s);
    });
    return map;
}

module.exports = { profileFor, profileMap, hostOf, version, TIERS, _internal: { normTier, normRes, normCodec, HOSTS, KEYS } };
