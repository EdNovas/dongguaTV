'use strict';
// [adult] scripts/site-catalog-test.mjs 用:直接往 catalog.db 灌 N 部合成作品(不走入库,只为测读路径 / 事件循环)。
//   片名 / 片商 / 演员全是合成的("合成片商12" / "Kakuu Actor 3"),不含任何真实人名。
const SCH = require('../../../lib/site-catalog/schema');

function synth(file, o) {
    const n = o.n;
    const adult = o.adult;
    const db = SCH.openDb(file, 'writer', {});
    SCH.initSchema(db);
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('rules', ?)").run(adult.RULES_VERSION);
    const vocab = adult.tags.VOCAB.filter((t) => t.kind !== 'blocked').map((t) => t.id);
    const featured = vocab.filter((id) => adult.tags.isFeatured(id));
    const buckets = adult.taxonomy.NAV_BUCKETS;
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const zipf = (arr) => arr[Math.min(arr.length - 1, Math.floor(Math.pow(rnd(), 2.2) * arr.length))];
    const ins = db.prepare(`INSERT INTO adult_works (wk, name, code, ckey, clean, bucket, tags, review, code_ok, pic, pic_item, dur_med, dur, n_sites, sites, live_sites, first_site,
        variants, flags, is_clip, first_seen, last_seen, line_at, rand, hot, vis, released, studio, maker, label, avdb, actress)
        VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,?,1,?,?,'','',?,?)`);
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
            ins.run(wk, (code ? 'ZZT-' + i + ' ' : '') + '合成作品标题' + i, code ? 'ZZT-' + i : null, code ? 'ZZT' + (i % 997) + '-' + String(i).padStart(6, '0') : null, '合成作品标题' + i,
                buckets[Math.floor(Math.pow(rnd(), 1.5) * buckets.length)], ',' + [...tags].join(',') + ',', 1, 'https://img.example/' + i + '.jpg', 's1|' + i,
                dur, dur, sites === ',s1,' ? 1 : 2, sites, sites, 's' + (1 + (i % 2)), rnd() < 0.1 ? 1 : 0, rnd() < 0.03 ? 1 : 0, fs, fs, fs + Math.floor(rnd() * 86400e3),
                Math.floor(rnd() * 2147483647), i < 60 ? 1000 - i : 0, rel, code ? '合成片商' + Math.floor(Math.pow(rnd(), 2) * 300) : '', code ? 1 : 0, act);
        }
    })();
    db.close();
}

module.exports = { synth };
