'use strict';
// [adult] scripts/site-catalog-test.mjs 用:直接往 catalog.db 灌 N 部合成作品(不走入库,只为测读路径 / 事件循环)。
//   片名 / 片商 / 演员全是合成的("合成片商12" / "Kakuu Actor 3"),不含任何真实人名。
//   第四阶段:short / live / creators 分区的作品各带 1 条线路(第一集 m3u8、方向、短时长),给刷一刷 / 相关推荐 / 热度的卡顿测试用
//   (另一个随机序列,不影响原来那些作品的分布)
const SCH = require('../../../lib/site-catalog/schema');
const { INGEST_REV } = require('../../../lib/site-catalog/writer');
const { COVER_REV } = require('../../../lib/site-catalog/cover-health');

function synth(file, o) {
    const n = o.n;
    const adult = o.adult;
    const db = SCH.openDb(file, 'writer', {});
    SCH.initSchema(db);
    // 规则键要和写线程算的一样(RULES_VERSION | INGEST_REV):库里有线路时规则不同会加一代、把这些合成行全当旧规则藏起来去重扫
    const rk = adult.RULES_VERSION + '|' + INGEST_REV;
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('rules', ?)").run(rk);
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('rv:rules', ?)").run(rk);
    // 封面域名健康:合成作品的封面已按"没有死域名"挑好(线路封面 = 作品封面),写线程不用再全量重挑一遍
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('cover:applied', ?)").run(JSON.stringify({ rev: COVER_REV, dead: '' }));
    const vocab = adult.tags.VOCAB.filter((t) => t.kind !== 'blocked').map((t) => t.id);
    const featured = vocab.filter((id) => adult.tags.isFeatured(id));
    const buckets = adult.taxonomy.NAV_BUCKETS;
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const zipf = (arr) => arr[Math.min(arr.length - 1, Math.floor(Math.pow(rnd(), 2.2) * arr.length))];
    const ins = db.prepare(`INSERT INTO adult_works (wk, name, code, ckey, clean, bucket, tags, review, code_ok, pic, pic_item, dur_med, dur, n_sites, sites, live_sites, first_site,
        variants, flags, is_clip, first_seen, last_seen, line_at, rand, hot, vis, released, studio, maker, label, avdb, actress, orient)
        VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,?,1,?,?,'','',?,?,?)`);
    const insItem = db.prepare(`INSERT INTO adult_items (site, vod_id, wk, bucket, name, first_seen, last_seen, play_from, play_url, play_at, dur, orient, pic)
        VALUES (?,?,?,?,?,?,?,'m3u8',?,?,?,?,?)`);
    let seed2 = 777;
    const rnd2 = () => { seed2 = (Math.imul(seed2, 1103515245) + 12345) >>> 0; return seed2 / 4294967296; };
    const FEEDB = new Set(['short', 'live', 'creators']);
    const t0 = o.now;
    db.transaction(() => {
        for (let i = 0; i < n; i++) {
            const code = i % 3 === 0;
            const wk = code ? 'c:ZZT' + (i % 997) + '-' + String(i).padStart(6, '0') : 't:合成作品' + i;
            const tags = new Set();
            const k = 2 + Math.floor(rnd() * 6);
            for (let j = 0; j < k; j++) tags.add(rnd() < 0.85 ? zipf(featured) : zipf(vocab));
            const dur = rnd() < 0.45 ? 0 : Math.floor(60 + rnd() * 9000);
            const fs = t0 - Math.floor(rnd() * 900 * 86400e3);
            const rel = code && rnd() < 0.6 ? new Date(fs - Math.floor(rnd() * 300) * 86400e3).toISOString().slice(0, 10) : '';
            const act = code && rnd() < 0.5 ? JSON.stringify([[1000 + Math.floor(Math.pow(rnd(), 2) * 5000), 'Kakuu Actor ' + (i % 5000)]]) : '';
            const sites = rnd() < 0.5 ? ',s1,' : ',s1,s2,';
            const bucket = buckets[Math.floor(Math.pow(rnd(), 1.5) * buckets.length)];
            const feedish = FEEDB.has(bucket);
            const du = feedish ? (rnd2() < 0.85 ? 10 + Math.floor(rnd2() * 280) : 0) : dur;
            const orient = feedish ? (rnd2() < 0.6 ? 'v' : rnd2() < 0.5 ? 'h' : '') : '';
            ins.run(wk, (code ? 'ZZT-' + i + ' ' : '') + '合成作品标题' + i, code ? 'ZZT-' + i : null, code ? 'ZZT' + (i % 997) + '-' + String(i).padStart(6, '0') : null, '合成作品标题' + i,
                bucket, ',' + [...tags].join(',') + ',', 1, 'https://img.example/' + i + '.jpg', 's1|' + i,
                du, du, sites === ',s1,' ? 1 : 2, sites, sites, 's' + (1 + (i % 2)), rnd() < 0.1 ? 1 : 0, rnd() < 0.03 ? 1 : 0, fs, fs, fs + Math.floor(rnd() * 86400e3),
                Math.floor(rnd() * 2147483647), i < 60 ? 1000 - i : 0, rel, code ? '合成片商' + Math.floor(Math.pow(rnd(), 2) * 300) : '', code ? 1 : 0, act, orient);
            if (feedish) insItem.run('s1', String(i), wk, bucket, '合成作品标题' + i, fs, fs, '第1集$https://media.example/s/' + i + '/index.m3u8', t0 - Math.floor(rnd2() * 5 * 86400e3), du, orient, 'https://img.example/' + i + '.jpg');
        }
    })();
    db.close();
}

module.exports = { synth };
