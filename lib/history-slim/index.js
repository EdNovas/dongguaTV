'use strict';
// 📦 观看历史条目"瘦身"(同步用):server.js 入库/下发时调用;public/index.html 推送前用同一套规则(测试校验两边一致)。
//
// 为什么:历史条目里的 groupData 是整张卡的快照 —— 每条线路的完整选集串(vod_play_url)、剧情简介、本机测速结果。
//   一条 24KB~200KB,50 条全量推送 1~9MB(缓存审计 P0-2:超过 5MB 直接 413、关页 beacon 超 64KB 必失败)。
// 规则:
//   · 只保留【上次用的那条线路】的选集串(继续观看就是用它直接开播;没有 lastSourceKey 时留第一条有选集的);
//     其它线路只留 vod_id/名字/站点/分类/年份 —— 在别的设备上切过去时会现拉详情。
//   · 去掉剧情简介、各线路海报(卡片用 groupData.pic / poster)、本机测速字段(latency/_testType/_srvOnly/_useProxy/
//     _proxyUrl/sourcesTestedAt —— 测速结果只对测的那台设备有意义,同步过去反而让别的设备 24h 内不重测、按错的结果选线)。
//   · 线路最多 40 条,选集串最多 60000 字。
const MAX_SOURCES = 40;
const MAX_PLAY_URL = 60000;

function slimSource(s, keepPlayUrl) {
    if (!s || typeof s !== 'object') return null;
    const o = { vod_id: s.vod_id, vod_name: s.vod_name, site_name: s.site_name, site_key: s.site_key };
    if (s.type_name) o.type_name = s.type_name;
    if (s.vod_year) o.vod_year = s.vod_year;
    if (keepPlayUrl && s.vod_play_url) o.vod_play_url = String(s.vod_play_url).slice(0, MAX_PLAY_URL);
    return o;
}

function slimHistoryItem(d) {
    if (!d || typeof d !== 'object') return d;
    const out = Object.assign({}, d);
    const g = d.groupData;
    if (g && typeof g === 'object' && Array.isArray(g.sources)) {
        const srcs = g.sources.slice(0, MAX_SOURCES);
        let keep = srcs.findIndex(s => s && s.site_key && s.site_key === d.lastSourceKey && s.vod_play_url);
        if (keep < 0) keep = srcs.findIndex(s => s && s.vod_play_url);
        out.groupData = {
            name: g.name,
            pic: g.pic,
            _work: g._work || '',
            _workSig: g._workSig || '',
            _workLabel: g._workLabel || '',
            sources: srcs.map((s, i) => slimSource(s, i === keep)).filter(Boolean),
        };
    }
    return out;
}

module.exports = { slimHistoryItem, slimSource, MAX_SOURCES, MAX_PLAY_URL };
