// [adult] 封面域名健康(contract「封面加载不出来就隐藏」的服务器那一半)。
//
//   为什么:资源站的封面图床经常整个没了(域名过期 / 被注销:fb.lj260522.top 一个域名就是 2.6 万部作品、某些站的全部封面),
//     卡片一张张灰着很难受。客户端能判"这张图坏了",但判不了"这个图床对所有人都死了" —— 弱网 / 被墙 / 运营商 DNS 都会让图加载失败。
//     服务器只认【对所有人都一样】的硬证据:DNS 说这个名字不存在(NXDOMAIN)。
//   规则(fail-safe:拿不准一律当活着):
//     · 死 = A 和 AAAA 都回 NXDOMAIN(c-ares 的 ENOTFOUND),而且连续两次、两次至少隔 confirmMinMs(默认 10 分钟)。
//       超时 / 拒绝 / 连不上解析器 / 任何别的错 = 不知道(既不算死,也不算活:状态不变)。名字存在但没有地址(ENODATA)= 不知道。
//     · 解析器自己有没有毛病(劫持 / 过滤 / 断网时的假应答)每轮都要先过关,不过关这一轮的 NXDOMAIN / SERVFAIL 全当不知道(applyRound):
//         全量轮:解析出地址的 ≥ 3 个,且 NXDOMAIN 不超过"有明确答复(有地址 + NXDOMAIN)"的 30% —— 只算这一轮之前没判死的域名
//           (早就死了的照样复查 / 复活,但不进比例:死域名多了不能把检测整个卡死);
//         确认轮(只复查等第二次的那几个,它们上一轮就是 NXDOMAIN,不能拿它们自己算比例):另查几个上一轮解析正常的封面域名当对照,
//         对照 ≥ 3 个解析出地址、且 ≥ 70% 正常才算数。
//     · 活 = 解析出地址;死的域名照样每轮复查,解析出地址立刻复活(作品封面跟着回来)。
//     · SERVFAIL(默认开,ADULT_COVER_SERVFAIL_DEAD=0 关):注册了、但授权服务器不应答 / 拒答的域名(lame delegation,例如域名还指着
//       Cloudflare 但区已经删了 —— fb.lj260522.top 就是这样,所有公共解析器都回 SERVFAIL,不是 NXDOMAIN)对所有人都打不开。
//       判死要同时满足:A / AAAA 都 SERVFAIL;再带 CD 位(不做 DNSSEC 校验)问一遍解析器还是 SERVFAIL(排除"DNSSEC 签坏了":
//       校验的解析器 SERVFAIL、不校验的解析器照样解析得出,那些用户还能看);只在全量轮、且这一轮解析器明显正常(≥3 个、≥70% 解析出地址、
//       SERVFAIL 不超过 30%)才记;连续 ≥ sfMin 次、首尾跨 ≥ sfMinMs(默认 3 次 / 24 小时)。解析出地址立刻复活。
//     · 只用 dns.promises.Resolver(c-ares,不占 libuv 线程池;dns.lookup 会)+ CD 位复核用的 UDP 小查询(dgram,也不占线程池),
//       查询并发 ≤ conc,一个查询(含 c-ares 换服务器重试)总共 ≈ timeoutMs。服务器从不下载图片。stop / close 立刻取消在途的一轮。
//   状态存在 catalog.db adult_meta 'cover:hosts'(重启不忘),主线程判、写线程按死域名挑封面(writer.js coverApply)。
//   作品封面挑选 pickCover:最新一条封面不在死域名上的线路;另给 ≤2 个别的活域名上的候补(alt);AVDB 封面域名没死才算封面。
'use strict';

const COVER_REV = 'c1';   // 挑封面的口径版本:变了 = 写线程把全部作品重挑一遍(补 pic_alt / cov)

// URL → 小写主机名;认不出 / 不是 http(s) / 协议相对 → ''
function hostOf(u) {
    if (typeof u !== 'string' || !u) return '';
    const m = /^\s*(?:https?:)?\/\/([^/?#\\\s]+)/i.exec(u);
    if (!m) return '';
    let a = m[1];
    const at = a.lastIndexOf('@');
    if (at >= 0) a = a.slice(at + 1);
    if (a.charAt(0) === '[') { const e = a.indexOf(']'); return e > 1 ? a.slice(0, e + 1).toLowerCase() : ''; }
    const c = a.indexOf(':');
    if (c >= 0) a = a.slice(0, c);
    a = a.toLowerCase().replace(/\.+$/, '');
    return a && a.length <= 253 && /^[a-z0-9_.-]+$/.test(a) ? a : '';
}
const isIpHost = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.charAt(0) === '[';
// 能拿去查 DNS 的名字:至少两段、每段 1..63、不是 IP
function checkable(h) {
    if (typeof h !== 'string' || !h || h.length > 253 || isIpHost(h)) return false;
    const parts = h.split('.');
    if (parts.length < 2) return false;
    for (const p of parts) if (!p || p.length > 63 || !/^[a-z0-9_-]+$/.test(p)) return false;
    return !/^\d+$/.test(parts[parts.length - 1]);
}
const okUrl = (u) => typeof u === 'string' && u.length <= 500 && /^https?:\/\/[^\s]+$/i.test(u);

// 作品封面:rows = 线路 [{site, vod_id, pic, last_seen}](顺序 = 库里的顺序,同 last_seen 取先出现的,与原 refreshWork 一致);
//   apic = AVDB 封面;dead = 死域名 Set。→ {pic, item:'site|vod_id'|null, alt:'url\nurl'(≤2 个别的活域名), cov:0|1}
function pickCover(rows, apic, dead) {
    const isDead = (u) => !!(dead && dead.size) && dead.has(hostOf(u));
    let best = null;
    const live = [];
    for (const r of rows || []) {
        if (!r || !r.pic || isDead(r.pic)) continue;
        live.push(r);
        if (!best || r.last_seen > best.last_seen) best = r;
    }
    const aLive = typeof apic === 'string' && /^https?:\/\//i.test(apic) && !isDead(apic);
    const alt = [];
    if (best) {
        const seen = new Set([hostOf(best.pic)]);
        const rest = live.filter((r) => r !== best).sort((a, b) => (Number(b.last_seen) || 0) - (Number(a.last_seen) || 0));
        for (const r of rest) {
            if (alt.length >= 2) break;
            const h = hostOf(r.pic);
            if (!h || seen.has(h) || !okUrl(r.pic)) continue;
            seen.add(h);
            alt.push(r.pic);
        }
        if (alt.length < 2 && aLive && okUrl(apic)) { const h = hostOf(apic); if (h && !seen.has(h)) alt.push(apic); }
    }
    return { pic: best ? best.pic : '', item: best ? best.site + '|' + best.vod_id : null, alt: alt.join('\n'), cov: best || aLive ? 1 : 0 };
}
// 卡片的候补地址(pic_alt 列 → 数组,≤2;坏的丢掉)
function altList(s) {
    if (typeof s !== 'string' || !s) return [];
    return s.split('\n').filter(okUrl).slice(0, 2);
}

// ---------- 状态 ----------
// {v:1, full:上次全量检查的时间, hosts:{host:{n:封面数, nx:连续 NXDOMAIN 次数, nxAt:这一串第一次的时间, dead, why:'nx'|'sf', at:上次查, okAt:上次解析出地址, deadAt,
//   sf / sfAt:连续 SERVFAIL 次数 / 这一串第一次的时间(只在可选的 SERVFAIL 规则开着时记)}}}
const blankHost = () => ({ n: 0, nx: 0, nxAt: 0, dead: false, why: '', at: 0, okAt: 0, deadAt: 0, sf: 0, sfAt: 0 });
function emptyState() { return { v: 1, full: 0, hosts: Object.create(null) }; }
function parseState(raw) {
    const s = emptyState();
    let j = null;
    try { j = typeof raw === 'string' && raw ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : null); } catch (_) { j = null; }
    if (!j || typeof j !== 'object' || !j.hosts || typeof j.hosts !== 'object') return s;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    s.full = num(j.full);
    let k = 0;
    for (const h of Object.keys(j.hosts)) {
        if (k >= 2000) break;
        const x = j.hosts[h];
        if (!checkable(h) || !x || typeof x !== 'object') continue;
        const dead = x.dead === true;
        s.hosts[h] = { n: num(x.n), nx: Math.min(2, num(x.nx)), nxAt: num(x.nxAt), dead, why: dead ? (x.why === 'sf' ? 'sf' : 'nx') : '', at: num(x.at), okAt: num(x.okAt), deadAt: num(x.deadAt),
            sf: Math.min(99, num(x.sf)), sfAt: num(x.sfAt) };
        k++;
    }
    return s;
}
function dumpState(s) { return JSON.stringify({ v: 1, full: s.full || 0, hosts: s.hosts || {} }); }
// 死域名。o.sf = 可选的 SERVFAIL 规则开着没有:关着时按 SERVFAIL 判死的不算(开关关掉后马上回来,不用等下一轮)
const isDeadX = (x, o) => !!x && x.dead === true && (x.why !== 'sf' || !!(o && o.sf));
function deadSet(s, o) {
    const out = new Set();
    if (!s || !s.hosts) return out;
    for (const h of Object.keys(s.hosts)) if (isDeadX(s.hosts[h], o)) out.add(h);
    return out;
}
// 死域名表(封面多的在前),≤ max 个
function deadList(s, max, o) {
    if (!s || !s.hosts) return [];
    return Object.keys(s.hosts).filter((h) => isDeadX(s.hosts[h], o))
        .sort((a, b) => (s.hosts[b].n - s.hosts[a].n) || (a < b ? -1 : 1)).slice(0, Math.max(0, max == null ? 200 : max));
}
// 等第二次确认的(一次 NXDOMAIN、还没判死)
function pendingList(s) {
    if (!s || !s.hosts) return [];
    return Object.keys(s.hosts).filter((h) => !s.hosts[h].dead && s.hosts[h].nx >= 1);
}
// 确认轮的对照:上一次查就解析出地址、没死、不在 exclude 里的封面域名(封面多的在前),≤ max 个
function controlList(s, max, exclude) {
    if (!s || !s.hosts) return [];
    const ex = exclude instanceof Set ? exclude : new Set(exclude || []);
    return Object.keys(s.hosts).filter((h) => { const x = s.hosts[h]; return !ex.has(h) && !x.dead && x.okAt > 0 && x.okAt === x.at && checkable(h); })
        .sort((a, b) => (s.hosts[b].n - s.hosts[a].n) || (a < b ? -1 : 1)).slice(0, Math.max(0, max == null ? 6 : max));
}

// 一次查询的结果 → 'ok' | 'nx' | 'sf' | 'unk'
//   a / b = {ok:true} 或 {code}(A / AAAA)。'sf' = 两个都 SERVFAIL(默认当 'unk';见 applyRound 的 sfDead)
function verdictOf(a, b) {
    if ((a && a.ok) || (b && b.ok)) return 'ok';
    if (a && b && a.code === 'ENOTFOUND' && b.code === 'ENOTFOUND') return 'nx';
    if (a && b && a.code === 'ESERVFAIL' && b.code === 'ESERVFAIL') return 'sf';
    return 'unk';
}
// 解析器过关的门槛(applyRound):明确答复里 NXDOMAIN 的上限、最少要解析出地址的个数、"明显正常"要解析出地址的比例、SERVFAIL 的上限
const GUARD = { nxMaxFrac: 0.3, minOk: 3, okFrac: 0.7, sfMaxFrac: 0.3 };
// 一轮检查的结果并进状态(原地改 s)。verdicts:Map host → 'ok'|'nx'|'sf'|'unk'(要判的域名);
//   o = {minGap, counts:Map host→n(全量检查时给), prune, pending, controls:Map host→verdict(确认轮的对照,只用来看解析器正不正常、不改状态),
//        sfDead, sfMin, sfMinMs}
//   → {suspicious, healthy, changed:[死活变了的域名], nx, ok, sf, unk(这一轮全部), guard:{ok, nx, sf, unk, n, deadBefore}(过关用的计数), ctl:{ok, n}}
//   解析器过关(不过关 = suspicious:这一轮的 NXDOMAIN 全当不知道;见文件头)只算【这一轮之前没死】的域名(guard):
//     早就判死的(一直 NXDOMAIN / SERVFAIL)照样复查、解析出地址照样复活,但不进比例 —— 否则死域名一多(> 30%)全量轮永远"可疑",
//     新死的再也判不出来,还每 6 小时报一次"解析器有问题"。
//     全量轮:ok ≥ 3 且 nx ≤ 30% ×(ok + nx)—— 分母只算明确答复(超时 / SERVFAIL 不稀释比例);域名太少(解析出地址的不到 3 个)也不判;
//     确认轮(o.pending):要判的域名上一轮全是 NXDOMAIN,拿它们自己算比例永远过不了关 → 只看对照:对照解析出地址 ≥ 3 个且 ≥ 70%。
//   SERVFAIL 规则(sfDead;index.js 默认开,ADULT_COVER_SERVFAIL_DEAD=0 关;'sf' 已经过了 checkHosts 的 CD 位复核):
//     只在全量轮、且解析器明显正常(过关、≥70% 解析出地址、SERVFAIL ≤ 30% ×(ok + sf))才记;连续 ≥ sfMin 次 SERVFAIL、首尾跨 ≥ sfMinMs
//     (默认 3 次 / 24 小时)→ 判死(why:'sf');解析出地址立刻复活;关掉开关后这些不再算死(deadSet / deadList 的 o.sf)
function applyRound(s, verdicts, t, o) {
    const opt = o || {};
    const minGap = Number(opt.minGap) >= 0 ? Number(opt.minGap) : 10 * 60e3;
    const sfOn = !!opt.sfDead;
    const sfMin = Math.max(2, Number(opt.sfMin) || 3);
    const sfMinMs = Number(opt.sfMinMs) >= 0 ? Number(opt.sfMinMs) : 24 * 3600e3;
    const pending = !!opt.pending;
    const dso = { sf: sfOn };
    const before = deadSet(s, dso);
    // 全部(日志 / 统计)和过关用的(只算这一轮之前没死的)
    const all = { ok: 0, nx: 0, sf: 0, unk: 0, n: 0 }, g = { ok: 0, nx: 0, sf: 0, unk: 0, n: 0, deadBefore: 0 };
    for (const [h, v] of verdicts) {
        const k = v === 'nx' || v === 'ok' || v === 'sf' ? v : 'unk';
        all[k]++; all.n++;
        if (before.has(h)) { g.deadBefore++; continue; }
        g[k]++; g.n++;
    }
    let okC = 0, nC = 0;
    if (opt.controls instanceof Map) for (const v of opt.controls.values()) { nC++; if (v === 'ok') okC++; }
    let suspicious, healthy;
    if (pending) {
        suspicious = !(okC >= GUARD.minOk && okC >= GUARD.okFrac * nC);
        healthy = false;   // SERVFAIL 只在全量轮记
    } else {
        suspicious = !(g.ok >= GUARD.minOk && g.nx <= GUARD.nxMaxFrac * (g.ok + g.nx));
        healthy = !suspicious && g.ok >= GUARD.okFrac * g.n && g.sf <= GUARD.sfMaxFrac * (g.ok + g.sf);
    }
    if (opt.counts instanceof Map) {
        if (opt.prune) for (const h of Object.keys(s.hosts)) if (!opt.counts.has(h)) delete s.hosts[h];
        for (const [h, n] of opt.counts) if (checkable(h)) { if (!s.hosts[h]) s.hosts[h] = blankHost(); s.hosts[h].n = Number(n) || 0; }
    }
    for (const [h, v] of verdicts) {
        if (!checkable(h)) continue;
        let x = s.hosts[h];
        if (!x) x = s.hosts[h] = blankHost();
        x.at = t;
        if (v === 'ok') { x.nx = 0; x.nxAt = 0; x.sf = 0; x.sfAt = 0; x.dead = false; x.why = ''; x.deadAt = 0; x.okAt = t; }
        else if (v === 'nx' && !suspicious && !isDeadX(x, dso)) {
            if (!(x.nx >= 1) || !(x.nxAt > 0) || t < x.nxAt) { x.nx = 1; x.nxAt = t; }
            else if (t - x.nxAt >= minGap) { x.nx = 2; x.dead = true; x.why = 'nx'; x.deadAt = t; }
            // 隔得太近:还算第一次,等下一次
        } else if (v === 'sf' && sfOn && healthy && !isDeadX(x, dso)) {
            if (!(x.sf >= 1) || !(x.sfAt > 0) || t < x.sfAt) { x.sf = 1; x.sfAt = t; }
            else {
                x.sf = Math.min(99, x.sf + 1);
                if (x.sf >= sfMin && t - x.sfAt >= sfMinMs) { x.dead = true; x.why = 'sf'; x.deadAt = t; }
            }
        }
        // 'unk' / 可疑的一轮 / 规则关着的 'sf':什么都不变
    }
    const after = deadSet(s, dso);
    const changed = [];
    for (const h of after) if (!before.has(h)) changed.push(h);
    for (const h of before) if (!after.has(h)) changed.push(h);
    return { suspicious, healthy, changed, nx: all.nx, ok: all.ok, sf: all.sf, unk: all.unk, guard: g, ctl: { ok: okC, n: nC } };
}

// 查一批域名:resolver = {resolve4, resolve6[, cdCheck(h, signal), cancel()]}(返回 Promise);并发 ≤ conc 个查询,
//   单次 ≤ timeoutMs(外面再包一层,解析器自己的超时坏了也不挂住)。
//   o.sfConfirm:A / AAAA 都 SERVFAIL 的,再用 resolver.cdCheck 带 CD 位复核 —— 还是 'sf' 才留 'sf',否则(DNSSEC 签坏了 / 复核不了)= 'unk'。
//   o.signal(AbortSignal):取消 → 不再发新查询、在途的立刻收尾(定时器清掉)、resolver.cancel();返回值不完整,调用方看 signal.aborted 丢掉
async function checkHosts(hosts, o) {
    const res = o.resolver;
    const sig = o.signal || null;
    const conc = Math.max(1, Math.min(8, Number(o.conc) || 8));
    const tmo = Math.max(100, Number(o.timeoutMs) || 5000);
    const out = new Map();
    const jobs = [];
    for (const h of hosts) if (checkable(h) && !out.has(h)) { out.set(h, 'unk'); jobs.push([h, 'resolve4'], [h, 'resolve6']); }
    const got = new Map();
    const live = new Set();   // 在途查询的"取消"函数(取消时一起收)
    const aborted = () => !!(sig && sig.aborted);
    // 一个查询 → {verdict:Promise(答复 / 超时就给结果), freed:Promise(底层查询真的结束了才让出并发名额)}。
    //   外层超时(timeoutMs + 1s)只决定这一问"不知道",名额要等底层查询自己结束(c-ares 一定会结束;取消时立刻结束),
    //   最多再等 2 × timeoutMs(假的 / 坏掉的解析器永远不回也不会卡住整轮)—— 这样真正在途的查询数严格 ≤ conc
    const one = (h, fn) => {
        let release = null;
        const freed = new Promise((r) => { release = r; });
        const verdict = new Promise((resolve) => {
            if (aborted()) { release(); resolve({ code: 'ECANCELLED' }); return; }
            let done = false, timer = null, hold = null;
            const fin = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
            const free = () => { clearTimeout(timer); clearTimeout(hold); live.delete(kill); release(); };
            const kill = () => { fin({ code: 'ECANCELLED' }); free(); };
            live.add(kill);
            // 不 unref:查询在途时这些定时器得撑住事件循环(挂住的查询也要按超时收尾),查完 / 取消立刻清掉
            timer = setTimeout(() => { fin({ code: 'ETIMEOUT' }); hold = setTimeout(free, 2 * tmo); }, tmo + 1000);
            try {
                const p = fn === 'cdCheck' ? res.cdCheck(h, sig) : res[fn](h);
                Promise.resolve(p).then((a) => { fin(fn === 'cdCheck' ? { cd: String(a || 'unk') } : Array.isArray(a) && a.length ? { ok: true } : { code: 'ENODATA' }); free(); },
                    (e) => { fin({ code: String((e && e.code) || 'ERR') }); free(); });
            } catch (e) { fin({ code: String((e && e.code) || 'ERR') }); free(); }
        });
        return { verdict, freed };
    };
    const onAbort = () => {
        for (const k of [...live]) k();
        try { if (res && typeof res.cancel === 'function') res.cancel(); } catch (_) { /* */ }
    };
    if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', onAbort, { once: true });
    const pool = async (list, each) => {
        let i = 0;
        const worker = async () => { while (i < list.length && !aborted()) { const job = list[i++]; await each(job); } };
        await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    };
    try {
        await pool(jobs, async ([h, fn]) => {
            const q = one(h, fn);
            const r = await q.verdict;
            if (!got.has(h)) got.set(h, {});
            got.get(h)[fn] = r;
            await q.freed;
        });
        for (const [h, r] of got) out.set(h, verdictOf(r.resolve4, r.resolve6));
        // SERVFAIL 的复核(很少:今天只有一个):CD 位下还是 SERVFAIL 才算
        const sfs = [...out].filter((x) => x[1] === 'sf').map((x) => x[0]);
        if (sfs.length) {
            if (!o.sfConfirm || !res || typeof res.cdCheck !== 'function') for (const h of sfs) out.set(h, o.sfConfirm ? 'unk' : 'sf');
            else await pool(sfs, async (h) => { const q = one(h, 'cdCheck'); const r = await q.verdict; out.set(h, r && r.cd === 'sf' ? 'sf' : 'unk'); await q.freed; });
        }
    } finally {
        if (sig && typeof sig.removeEventListener === 'function') sig.removeEventListener('abort', onAbort);
    }
    return out;
}

// ---------- CD 位复核(dgram 发一个最小的 DNS 查询;c-ares 的 API 设不了 CD 位)----------
// 解析器地址:'1.2.3.4' / '1.2.3.4:5353' / '2001:db8::1' / '[2001:db8::1]:5353' → {host, port, fam}
function parseServer(s) {
    const v = String(s || '').trim();
    let m = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(v);
    if (m) return { host: m[1], port: Number(m[2]) || 53, fam: 'udp6' };
    m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(v);
    if (m) return { host: m[1], port: Number(m[2]) || 53, fam: 'udp4' };
    if (/^[0-9a-f:.]+$/i.test(v) && v.indexOf(':') >= 0) return { host: v, port: 53, fam: 'udp6' };
    return null;
}
// 一个 A 查询(RD + CD)的报文;name 已过 checkable
function dnsQuery(id, name) {
    const parts = [Buffer.from([id >> 8, id & 255, 0x01, 0x10, 0, 1, 0, 0, 0, 0, 0, 0])];
    for (const l of name.split('.')) { parts.push(Buffer.from([l.length])); parts.push(Buffer.from(l, 'ascii')); }
    parts.push(Buffer.from([0, 0, 1, 0, 1]));
    return Buffer.concat(parts);
}
// 问一个解析器 → RCODE(0 NOERROR / 2 SERVFAIL / 3 NXDOMAIN / 5 REFUSED …)或 -1(超时 / 出错 / 取消)
function rcodeOf(srv, name, tmo, sig) {
    return new Promise((resolve) => {
        let sock = null, timer = null, done = false;
        const fin = (v) => {
            if (done) return;
            done = true; clearTimeout(timer);
            if (sig && typeof sig.removeEventListener === 'function') sig.removeEventListener('abort', onAbort);
            try { if (sock) sock.close(); } catch (_) { /* */ }
            resolve(v);
        };
        const onAbort = () => fin(-1);
        if (sig && sig.aborted) { resolve(-1); return; }
        if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', onAbort, { once: true });
        try {
            const id = require('crypto').randomInt(65536);
            sock = require('dgram').createSocket(srv.fam);
            sock.on('error', () => fin(-1));
            sock.on('message', (m) => {
                // 只认自己那一问的回答(ID 对得上、QR=1)
                if (!Buffer.isBuffer(m) || m.length < 12 || m.readUInt16BE(0) !== id || !(m[2] & 0x80)) return;
                fin(m[3] & 15);
            });
            timer = setTimeout(() => fin(-1), tmo);
            sock.send(dnsQuery(id, name), srv.port, srv.host, (e) => { if (e) fin(-1); });
        } catch (_) { fin(-1); }
    });
}
// CD 位下这个名字在解析器那里是什么:'sf'(每个回答的服务器都 SERVFAIL)/ 'ok' / 'nx' / 'unk'(没有服务器回答)。
//   服务器挨个问(很少用到,不并发);回 REFUSED 的服务器不算数(它不给我们查)
async function cdServfail(name, servers, tmo, sig) {
    if (!checkable(name)) return 'unk';
    let sf = 0;
    for (const s of (Array.isArray(servers) ? servers : []).slice(0, 4)) {
        if (sig && sig.aborted) return 'unk';
        const srv = parseServer(s);
        if (!srv) continue;
        const rc = await rcodeOf(srv, name, tmo, sig);
        if (rc === 0) return 'ok';
        if (rc === 3) return 'nx';
        if (rc === 2) sf++;
    }
    return sf > 0 ? 'sf' : 'unk';
}
// c-ares(1.34)一个查询的实际寿命随单次超时 × 服务器数走,但会按自己的规则取整 / 退避:实测 tries:1、单次 T 时
//   3 台:T=1000 → 4.0s、T=1250 → 6.1s;2 台:T=1250 → 4.0s;1 台:T=1666 → 2.0s、T=1000 → 2.0s;4 台:T=833 → 4.2s。
//   单次超时取 总预算 ÷(服务器数 + 2),5 秒预算下 1~4 台都在 ~4 秒内结束(在 checkHosts 外层超时之内);并发上限另由 checkHosts 等底层结束保证
const perTryMs = (total, n) => Math.max(200, Math.floor(Math.max(200, Number(total) || 5000) / (Math.max(1, Number(n) || 1) + 2)));
// 默认解析器:c-ares(系统配置的 DNS 服务器;每轮新建一个,系统 DNS 改了也跟得上),一个查询总共 ≈ timeoutMs、不重试;
//   cancel() 取消在途查询;cdCheck = CD 位复核(同一组服务器)
function makeResolver(timeoutMs, servers) {
    const { Resolver } = require('dns').promises;
    const total = Math.max(200, Number(timeoutMs) || 5000);
    let n = 1;
    try { const p = new Resolver(); if (servers) p.setServers(servers); n = p.getServers().length || 1; } catch (_) { n = 1; }
    const per = perTryMs(total, n);
    let r;
    try { r = new Resolver({ timeout: per, tries: 1 }); } catch (_) { r = new Resolver(); }
    if (servers) { try { r.setServers(servers); } catch (_) { /* 保持系统的 */ } }
    const list = () => { try { return r.getServers(); } catch (_) { return []; } };
    return {
        resolve4: (h) => r.resolve4(h), resolve6: (h) => r.resolve6(h),
        cancel: () => { try { r.cancel(); } catch (_) { /* */ } },
        getServers: list,
        // 服务器挨个问,每台 ≤ 总预算 / 台数(≤2s):整个复核也在 checkHosts 外层的超时(timeoutMs + 1s)之内
        cdCheck: (h, sig) => { const l = list(); return cdServfail(h, l, Math.max(200, Math.min(2000, Math.floor(total / Math.max(1, Math.min(4, l.length))))), sig); },
        perTryMs: per,
    };
}
// ADULT_COVER_HEALTH_DISABLE 这类开关:和 server.js envFlag 同口径(空 / 0 / false / no / off = 没开)
function envOn(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}

module.exports = {
    COVER_REV, GUARD, hostOf, checkable, pickCover, altList, emptyState, parseState, dumpState, deadSet, deadList, pendingList, controlList,
    verdictOf, applyRound, checkHosts, makeResolver, perTryMs, parseServer, dnsQuery, cdServfail, envOn,
};
