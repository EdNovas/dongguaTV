'use strict';
// 卡片预览片(成人站卡片上悬停 / 长按放的那几秒):从视频里均匀挑几段(每段 2.5 秒),用 ffmpeg 拼成一个 360p 静音小 MP4(几百 KB),存磁盘。
//   源视频走本机自己的 /v/(同一套 1MB 分块缓存;moov 在文件尾的也行):开做之前把各段大概所在的块和文件尾并发预取进缓存,
//   ffmpeg 读的时候多半已经在本地 —— 冷启动从"一段一段顺着等 Telegram"变成"几块一起拉"。
//   同时最多 par 个在做,排队的超过 queueMax 个直接回忙(浏览器那边就不预览,不会排一长串);做失败的记 10 分钟不再做。
//   没装 ffmpeg → 一律回"没有"(成人站照常,只是 TG 作品没有预览)。
//   后台预做(warm):成人站同步到新收录的帖子时把消息号交过来(只给真收进库的,被拦的不会来),中转闲着时一个一个做好,
//   用户第一次长按就不用等那几秒。RELAY_PREVIEW_WARM=0 关掉。
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { log } = require('./common');

const CLIP_SEC = 2.5;
const FAIL_MS = 10 * 60e3;
// 后台预做(成人站同步到新帖子时叫 /api/warm):排在用户的请求后面 —— 一次一个、没有用户在等预览片、在转的视频流不多(canBg)才做,做完歇一会
const BG_MAX = 2000, BG_GAP_MS = 2000, BG_WAIT_MS = 10e3;

// 挑哪几段:掐掉开头(片头 / 水印口播)和结尾,中间均匀撒;短片少挑几段
function clipPlan(dur) {
    const d = Number(dur) || 0;
    if (d < 6) return [];
    if (d < 30) return [{ ss: +Math.min(2, d * 0.1).toFixed(2), t: +Math.min(8, d * 0.6).toFixed(2) }];
    const k = d < 300 ? 3 : d < 1200 ? 4 : 5;
    const lo = Math.max(d * 0.08, 10), hi = Math.max(lo + 1, d - Math.max(d * 0.06, 8) - CLIP_SEC);
    const out = [];
    for (let i = 0; i < k; i++) out.push({ ss: +(lo + (hi - lo) * (i + 0.5) / k).toFixed(2), t: CLIP_SEC });
    return out;
}

// 每段一个输入(-ss 放在 -i 前 = 先按关键帧跳过去再精确切),各自缩到 360p 高、24fps,拼起来;不要声音;faststart 让浏览器拿到就能放
function ffmpegArgs(src, clips, out) {
    const a = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    // X-Relay-Preview:中转对这种请求不顺着往后预取两块(ffmpeg 每段只读几秒,预取的块多半用不上,白从 Telegram 拉)
    for (const c of clips) a.push('-rw_timeout', '30000000', '-headers', 'X-Relay-Preview: 1\r\n', '-ss', String(c.ss), '-t', String(c.t), '-i', src);
    const f = clips.map((_, i) => `[${i}:v:0]scale=w=-2:h='trunc(min(360,ih)/2)*2',fps=24,setsar=1,format=yuv420p[v${i}]`);
    f.push(clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[out]`);
    a.push('-filter_complex', f.join(';'), '-map', '[out]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '31', '-profile:v', 'main', '-threads', '2',
        '-movflags', '+faststart', '-f', 'mp4', out);
    return a;
}

function pvErr(code, msg) { const e = new Error(msg || code); e.pvCode = code; return e; }

class Previews {
    // o: { dir, capBytes, par, queueMax, ffmpeg, timeoutMs, srcUrl(ch,id) → 本机 /v/ 签名地址, meta(ch,id) → {size,dur,...}, prefetch(ch,id,meta,clips),
    //      bg(默认 true:接受后台预做), canBg() → 现在能不能做后台的(中转不忙), bgGapMs / bgWaitMs }
    constructor(o) {
        this.dir = o.dir;
        this.cap = Math.max(16 * 1048576, Number(o.capBytes) || 10 * 1073741824);
        this.par = Math.max(1, o.par || 2);
        this.queueMax = Math.max(0, o.queueMax == null ? 16 : o.queueMax);
        this.bin = o.ffmpeg || 'ffmpeg';
        this.timeoutMs = o.timeoutMs || 90e3;
        this.srcUrl = o.srcUrl; this.meta = o.meta; this.prefetch = o.prefetch || null;   // 做之前把各段所在的块拉进缓存(server.js 的 warmClips)
        this.idx = new Map();          // 文件名 -> 大小;Map 顺序 = 最近使用顺序
        this.total = 0;
        this.inflight = new Map();
        this.failed = new Map();       // 文件名 -> {at, why}
        this.running = 0;
        this.waiting = [];
        this.ok = false;
        this.made = 0; this.fails = 0; this.hits = 0;
        this.bgOn = o.bg !== false;
        this.canBg = typeof o.canBg === 'function' ? o.canBg : () => true;
        this.bgGapMs = o.bgGapMs == null ? BG_GAP_MS : o.bgGapMs;
        this.bgWaitMs = o.bgWaitMs == null ? BG_WAIT_MS : o.bgWaitMs;
        this.bg = []; this.bgSet = new Set(); this.bgT = null; this.bgBusy = false; this.bgMade = 0; this.bgFail = 0;
    }
    init() {
        fs.mkdirSync(this.dir, { recursive: true });
        const rows = [];
        for (const n of fs.readdirSync(this.dir)) {
            const f = path.join(this.dir, n);
            if (!/^[a-z0-9_]+_\d+\.mp4$/.test(n)) { try { fs.unlinkSync(f); } catch (_) { /* 残留的临时文件 */ } continue; }
            try { const st = fs.statSync(f); rows.push([n, st.size, st.mtimeMs]); } catch (_) { /* 刚被删 */ }
        }
        rows.sort((a, b) => a[2] - b[2]);
        for (const [n, size] of rows) { this.idx.set(n, size); this.total += size; }
        this._evict();
        let r = null;
        try { r = spawnSync(this.bin, ['-hide_banner', '-version'], { timeout: 10e3, encoding: 'utf8' }); } catch (_) { r = null; }
        this.ok = !!(r && r.status === 0);
        log('[preview]', this.ok ? 'ffmpeg 可用' : '没找到 ffmpeg(apt install ffmpeg;装好重启):TG 作品没有卡片预览', '已有', this.idx.size, '个,', (this.total / 1048576).toFixed(1), 'MB');
    }
    name(ch, id) { return String(ch).toLowerCase() + '_' + id + '.mp4'; }
    stat() {
        return { ok: this.ok, files: this.idx.size, bytes: this.total, cap: this.cap, running: this.running, waiting: this.waiting.length, made: this.made, fails: this.fails, hits: this.hits,
            bg: { on: this.bgOn, queue: this.bg.length, made: this.bgMade, fails: this.bgFail } };
    }

    // 后台预做:已经有的 / 在做的 / 刚做失败的 / 已经排着的不重复排;队列满了后面的不收
    warm(ch, ids) {
        if (!this.ok || !this.bgOn) return { queued: 0, have: 0, on: false };
        let queued = 0, have = 0;
        for (const id of Array.isArray(ids) ? ids : []) {
            const n = this.name(ch, id);
            if (this.idx.has(n)) { have++; continue; }
            if (this.bgSet.has(n) || this.inflight.has(n)) continue;
            const f = this.failed.get(n);
            if (f && Date.now() - f.at < FAIL_MS) continue;
            if (this.bg.length >= BG_MAX) break;
            this.bg.push({ ch, id: String(id), n });
            this.bgSet.add(n);
            queued++;
        }
        this._bgKick(this.bgGapMs);
        return { queued, have, on: true };
    }
    _bgKick(ms) {
        if (this.bgT || this.bgBusy || !this.bg.length) return;
        this.bgT = setTimeout(() => { this.bgT = null; this._bgRun(); }, ms);
        if (this.bgT.unref) this.bgT.unref();
    }
    async _bgRun() {
        if (this.bgBusy || !this.bg.length) return;
        // 用户在等预览片 / 视频流多 → 过一会再看
        if (this.running > 0 || this.waiting.length > 0 || !this.canBg()) { this._bgKick(this.bgWaitMs); return; }
        const job = this.bg.shift();
        this.bgSet.delete(job.n);
        this.bgBusy = true;
        try { await this.get(job.ch, job.id); this.bgMade++; } catch (_) { this.bgFail++; }
        this.bgBusy = false;
        this._bgKick(this.bgGapMs);
    }

    async get(ch, id) {
        if (!this.ok) throw pvErr('no-ffmpeg');
        const n = this.name(ch, id);
        if (this.idx.has(n)) {
            try {
                const buf = await fs.promises.readFile(path.join(this.dir, n));
                const size = this.idx.get(n);
                this.idx.delete(n); this.idx.set(n, size);
                this.hits++;
                return buf;
            } catch (_) { this.total -= this.idx.get(n) || 0; this.idx.delete(n); }
        }
        const f = this.failed.get(n);
        if (f && Date.now() - f.at < FAIL_MS) throw pvErr('failed', f.why);
        let p = this.inflight.get(n);
        if (!p) {
            if (this.running >= this.par && this.waiting.length >= this.queueMax) throw pvErr('busy');
            p = this._slot().then(() => this._make(ch, id, n)).finally(() => { this.inflight.delete(n); this._release(); });
            this.inflight.set(n, p);
        }
        return p;
    }
    _slot() {
        if (this.running < this.par) { this.running++; return Promise.resolve(); }
        return new Promise((resolve) => this.waiting.push(resolve));
    }
    _release() {
        const next = this.waiting.shift();
        if (next) next(); else this.running--;
    }
    async _make(ch, id, n) {
        const tmp = path.join(this.dir, n + '.' + process.pid + '.tmp');
        try {
            const meta = await this.meta(ch, id);
            const clips = clipPlan(meta && meta.dur);
            if (!clips.length) throw pvErr('failed', 'too-short');
            if (this.prefetch) { try { this.prefetch(ch, id, meta, clips); } catch (_) { /* 只是预热 */ } }
            const t0 = Date.now();
            await this._ffmpeg(ffmpegArgs(this.srcUrl(ch, id), clips, tmp));
            const st = await fs.promises.stat(tmp);
            if (!(st.size > 2048)) throw pvErr('failed', 'empty');
            await fs.promises.rename(tmp, path.join(this.dir, n));
            if (!this.idx.has(n)) { this.idx.set(n, st.size); this.total += st.size; }
            this._evict();
            this.made++;
            log('[preview]', ch + '/' + id, clips.length + ' 段', (st.size / 1024).toFixed(0) + 'KB', ((Date.now() - t0) / 1000).toFixed(1) + 's');
            return await fs.promises.readFile(path.join(this.dir, n));
        } catch (e) {
            fs.promises.unlink(tmp).catch(() => {});
            // 账号 / 网络一时不行(no-account、FLOOD)不记失败,下次照样能做;源本身不行(太短、ffmpeg 读不了)记 10 分钟
            if (e && e.code !== 'no-account' && !/FLOOD/.test(String(e.errorMessage || e.message))) {
                this.failed.set(n, { at: Date.now(), why: String((e && (e.pvCode === 'failed' ? e.message : e.errorMessage || e.message)) || 'error').slice(0, 60) });
                if (this.failed.size > 5000) this.failed.delete(this.failed.keys().next().value);
                this.fails++;
            }
            throw e;
        }
    }
    _ffmpeg(args) {
        return new Promise((resolve, reject) => {
            let err = '';
            const p = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }, this.timeoutMs);
            p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
            p.on('error', (e) => { clearTimeout(t); reject(pvErr('failed', 'spawn ' + e.code)); });
            p.on('close', (code, sig) => {
                clearTimeout(t);
                if (code === 0) resolve();
                else reject(pvErr('failed', sig ? 'ffmpeg ' + sig : 'ffmpeg ' + code + ' ' + err.trim().split('\n').pop().slice(0, 120)));
            });
        });
    }
    _evict() {
        if (this.total <= this.cap) return;
        const goal = this.cap * 0.9;
        for (const [n, size] of this.idx) {
            if (this.total <= goal) break;
            if (this.inflight.has(n)) continue;
            this.idx.delete(n);
            this.total -= size;
            fs.promises.unlink(path.join(this.dir, n)).catch(() => {});
        }
    }
}

module.exports = { Previews, clipPlan, ffmpegArgs, CLIP_SEC };
