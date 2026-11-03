'use strict';
// ⏭️ 片头标记的合并规则(server.js POST /api/intro/mark 调用;scripts/intro-mark-migrate-test.mjs 直接跑)。
//
// 为什么单独成文件:片头算法升级后(标记版本 mv:2,见 public/index.html 的 <dg-intro-core>)新旧页面会同时在线,
//   这段规则决定两边互不写坏对方的数据,必须能脱离服务器测。
// 优先级只有一条:新算法值 > 旧值。片头、贴片、片尾各按同样的规则,不做加权平均、不计票、不削票:
//   · 新算法值遇到已有的新算法值:保留已有值,不翻来翻去。
//   · 新算法值遇到旧值:直接覆盖(旧算法系统性偏短,100.0 和 101.1 平均成 100.6 谁都不对)。
//   · 不带 mv 的上报(老页面、边看边学引擎)动不了新算法值;只能写入空位或旧值,后写覆盖。
//   线上旧数据里的 v/bv/ev 留着不读;src:'manual' 的记录没有身份校验、时间轴也可能不对,和别的旧值一样对待,能被新算法覆盖。
// 第三集确认:学习对算出的标记先是待确认(pend:1),只亮按钮。它带着学习对的 id(pid),包络也带同一个 pid;
//   这条包络在学习对之外的集定位命中(带 pid、不带 pend 的上报;算不算学习对之外由客户端按集号体系判,见 IntroCore.pairWitness),同 pid 的待确认标记才转正。确认只认 pid,不数集数:
//   两个学习对各算各的,凑够几集也互相确认不了(伪装者那种假片头,别的集都不中,就永远不会被自动跳)。
// 墓碑(miss):算不出来的集记下来,不再每个观众每个会话重抓一遍。1=有包络但定位不中,2=冷启动学不出,3=两样都不中;
//   原有的旧值留着继续亮按钮。真值到了直接覆盖墓碑;墓碑不能盖掉真值;老页面也动不了墓碑(新页面已判过了)。
// 贴片算法升过版(bmv:3,判定见 public/index.html 的 IntroCore.bumpLocate):高版本的值低版本盖不掉,同版本不翻来翻去,高版本能盖低版本。bmv:2 的旧贴片留着,页面只亮按钮。
const MARK_V = 2;
const BUMP_V = 3;
const hasOp = (m) => !!(m && m.oe > m.os);
const isNew = (m) => !!(m && m.mv === MARK_V && !m.miss && hasOp(m));

// inc = { os, oe, mv, pid, pend }。返回片头字段合好的新记录(贴片/片尾由调用方在此基础上合)
function mergeOp(old, inc, now) {
    const mv2 = inc.mv === MARK_V;
    if (isNew(old)) return mv2 ? { ...old, at: now } : { ...old };
    if (old && old.mv === MARK_V && !mv2) return { ...old };
    const r = { os: inc.os, oe: inc.oe, at: now };
    if (mv2) {
        r.mv = MARK_V;
        if (inc.pid) r.pid = inc.pid;
        if (inc.pend) r.pend = 1;
    }
    return r;
}

// inc = { bs, be, mv, bmv, pend }(bs 为 null 表示这次没带贴片)。贴片的新算法标记是 bmv;没带 bmv 的新算法上报(老页面)算 2
//   待确认的贴片不能落到已确认的记录上:闸门按整条记录看 pend,落上去就绕过了第三集确认
function mergeBump(rec, oldRec, inc) {
    const obs = oldRec && oldRec.be > oldRec.bs ? oldRec : null;
    const incV = inc.bmv || (inc.mv === MARK_V ? MARK_V : 0);
    const keep = () => {
        if (obs) {
            rec.bs = obs.bs; rec.be = obs.be;
            if (obs.bv) rec.bv = obs.bv; else delete rec.bv;
            if (obs.bmv) rec.bmv = obs.bmv; else delete rec.bmv;
        }
        return rec;
    };
    if (inc.bs == null || (obs && obs.bmv && obs.bmv >= incV) || (inc.pend && isNew(rec) && !rec.pend)) return keep();
    rec.bs = inc.bs; rec.be = inc.be;
    delete rec.bv;
    if (incV) rec.bmv = incV; else delete rec.bmv;
    return rec;
}

// inc = { ed, emv }(ed 为 null 表示这次没带片尾)。片尾的新算法标记是 emv
function mergeOutro(rec, oldRec, inc) {
    const obs = oldRec && oldRec.ed > 0 ? oldRec : null;
    const keep = () => {
        if (obs) {
            rec.ed = obs.ed;
            if (obs.ev) rec.ev = obs.ev; else delete rec.ev;
            if (obs.emv) rec.emv = obs.emv; else delete rec.emv;
        }
        return rec;
    };
    if (inc.ed == null || (obs && obs.emv === MARK_V)) return keep();
    rec.ed = inc.ed;
    delete rec.ev;
    if (inc.emv === MARK_V) rec.emv = MARK_V; else delete rec.emv;
    return rec;
}

// 墓碑:kind 1=定位不中 2=学不出 3=两样都不中
function applyMiss(old, kind, now) {
    if (isNew(old)) return { ...old };
    const r = { ...(old || {}), os: (old && old.os) || 0, oe: (old && old.oe) || 0, mv: MARK_V, miss: kind, mt: now, at: now };
    delete r.v; delete r.src; delete r.pend; delete r.pid;
    return r;
}

// 第三集确认。report = { mv, pid, pend },epKey 是这次写的那条。整张表原地改
function settlePair(map, epKey, report) {
    if (report.mv !== MARK_V || !report.pid) return;
    const same = Object.keys(map).map((k) => map[k]).filter((m) => m && m.pid === report.pid);
    if (!report.pend) {
        for (const m of same) delete m.pend;
    } else if (map[epKey] && map[epKey].pid === report.pid && same.some((m) => isNew(m) && !m.pend)) {
        delete map[epKey].pend;   // 已经被确认过的包络:后来才算到学习对的这一集(比如别的线路借来定位),直接算确认过
    }
}

// 读标记时去掉 bmv:2:还开着的老页面按 bmv===2 自动跳贴片,不去掉就要等它们刷新才停。只改下发的副本,存的不动
function marksForRead(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
        const m = map[k];
        if (m && m.bmv === MARK_V) { const { bmv, ...rest } = m; out[k] = rest; } else out[k] = m;
    }
    return out;
}

module.exports = { MARK_V, BUMP_V, mergeOp, mergeBump, mergeOutro, applyMiss, settlePair, marksForRead };
