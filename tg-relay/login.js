#!/usr/bin/env node
'use strict';
// 登录 Telegram 账号给中转用(每个账号运行一次;手机号 / 验证码 / 二步验证密码只在这个终端里输入)
//   node login.js            登录一个新账号(扫二维码 或 手机号 + 验证码)
//   node login.js --list     看已登录的账号
//   node login.js --remove <名字>   删掉一个账号(中转 30 秒内自动断开它)
// 登录结果存在 data/sessions.json —— 拿到这个文件的人能直接用这些账号,别外传、别提交到 git。
const path = require('path');
const readline = require('readline');
const { loadEnv, readJson, writeJson } = require('./lib/common');

loadEnv(__dirname);
const DATA = path.resolve(__dirname, process.env.RELAY_DATA || 'data');
const FILE = path.join(DATA, 'sessions.json');

function ask(q) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); resolve(String(a || '').trim()); });
    });
}
// 输入时不回显(二步验证密码)
function askHidden(q) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.stdoutMuted = false;
        rl._writeToOutput = function (s) { if (!rl.stdoutMuted) rl.output.write(s); else if (!/^\r?\n$/.test(s)) rl.output.write('*'); };
        rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(String(a || '')); });
        rl.stdoutMuted = true;
    });
}

const errText = (e) => String((e && (e.errorMessage || e.message)) || e);
function floodOf(e) {
    if (e && typeof e.seconds === 'number' && /FLOOD/.test(errText(e))) return e.seconds;
    const m = errText(e).match(/FLOOD_WAIT_?(\d+)/);
    return m ? Number(m[1]) : null;
}
const waitText = (s) => (s >= 3600 ? Math.round(s / 360) / 10 + ' 小时' : s >= 120 ? Math.round(s / 60) + ' 分钟' : s + ' 秒');

// Telegram 常见登录错误 → 中文
const ERR_ZH = {
    PHONE_NUMBER_INVALID: '手机号不对(要带国家码,例如 +12025550123 / +8613800000000)',
    PHONE_NUMBER_BANNED: '这个手机号被 Telegram 封了',
    PHONE_NUMBER_FLOOD: '这个号最近请求验证码太多次,Telegram 暂时不给发了,过几个小时再试',
    PHONE_NUMBER_UNOCCUPIED: '这个手机号还没注册 Telegram',
    PHONE_CODE_INVALID: '验证码不对',
    PHONE_CODE_EXPIRED: '验证码过期了',
    PHONE_CODE_EMPTY: '没输验证码',
    SEND_CODE_UNAVAILABLE: '没有别的发送方式了(短信 / 电话都用过了)',
    PHONE_PASSWORD_FLOOD: '二步验证密码试错太多次,过一阵再试',
    PASSWORD_HASH_INVALID: '二步验证密码不对',
    EMAIL_INVALID: '邮箱格式不对',
    EMAIL_NOT_ALLOWED: '这个邮箱 Telegram 不让用,换一个',
    CODE_INVALID: '邮箱验证码不对',
    EMAIL_VERIFY_EXPIRED: '邮箱验证码过期了',
    API_ID_INVALID: 'TG_API_ID / TG_API_HASH 不对(去 my.telegram.org 核对)',
    API_ID_PUBLISHED_FLOOD: '这个 api_id 被 Telegram 限制了,去 my.telegram.org 用别的号申请一个新的',
};
function zh(e) {
    const f = floodOf(e);
    if (f != null) return '请求太频繁,Telegram 要求等 ' + waitText(f) + ' 再试';
    const k = errText(e);
    return ERR_ZH[k] ? ERR_ZH[k] + '(' + k + ')' : k;
}

// 手机号:必须带国家码(+ 或 00 开头),去掉空格横杠括号
function normalizePhone(raw) {
    const s = String(raw || '').trim().replace(/[\s\-().]/g, '');
    const m = /^(?:\+|00)(\d{7,15})$/.exec(s);
    return m ? '+' + m[1] : null;
}

// 验证码发到哪了(Telegram 自己决定,第一次通常发到这个号已经登录着的 App 里,不是短信)
const NEXT_ZH = { CodeTypeSms: '短信', CodeTypeCall: '打电话', CodeTypeFlashCall: '来电(看来电号码)', CodeTypeMissedCall: '未接来电(看来电号码)', CodeTypeFragmentSms: 'Fragment 短信' };
function describeSent(sent) {
    const t = (sent && sent.type) || {};
    const k = t.className || '';
    const len = t.length ? ',' + t.length + ' 位' : '';
    let how;
    let canUse = true;
    switch (k) {
        case 'auth.SentCodeTypeApp': how = '发到了这个号【已经登录着的 Telegram App】里,不是短信 —— 打开手机 / 电脑上登录着这个号的 Telegram,看对话列表里叫「Telegram」、带蓝色认证勾的那个对话' + len; break;
        case 'auth.SentCodeTypeSms': how = '短信' + len; break;
        case 'auth.SentCodeTypeSmsWord': how = '短信(验证码是一个英文单词' + (t.beginning ? ',以 ' + t.beginning + ' 开头' : '') + ')'; break;
        case 'auth.SentCodeTypeSmsPhrase': how = '短信(验证码是一句英文' + (t.beginning ? ',以 ' + t.beginning + ' 开头' : '') + ')'; break;
        case 'auth.SentCodeTypeCall': how = '打电话念给你' + len; break;
        case 'auth.SentCodeTypeFlashCall': how = '一个马上挂断的来电,验证码 = 来电号码(整个号码)'; break;
        case 'auth.SentCodeTypeMissedCall': how = '一个未接来电,验证码 = 来电号码最后 ' + (t.length || '几') + ' 位' + (t.prefix ? '(来电号码以 ' + t.prefix + ' 开头)' : ''); break;
        case 'auth.SentCodeTypeEmailCode': how = '邮箱 ' + (t.emailPattern || '') + len; break;
        case 'auth.SentCodeTypeFragmentSms': how = 'Fragment 匿名号码,验证码在 ' + (t.url || 'fragment.com') + ' 里看' + len; break;
        case 'auth.SentCodeTypeFirebaseSms': how = 'Firebase 短信 —— 这种只有官方安卓 / iOS App 收得到,这个程序收不到'; canUse = false; break;
        case 'auth.SentCodeTypeSetUpEmailRequired': how = 'Telegram 要求这个号先绑定一个登录邮箱'; canUse = false; break;
        default: how = k || '未知方式';
    }
    const nk = sent && sent.nextType && String(sent.nextType.className || '').replace(/^auth\./, '');
    return { kind: k.replace(/^auth\./, ''), how, canUse, next: nk ? NEXT_ZH[nk] || nk : null, timeout: (sent && sent.timeout) || 0 };
}

// 手机号 + 验证码登录。io = { ask, askHidden, log };成功返回 user,失败抛错(err.zh 是给人看的说明)
async function codeLogin(client, creds, io) {
    const { Api } = require('telegram');
    const fail = (msg) => Object.assign(new Error(msg), { zh: msg });
    let phone = null;
    while (!phone) {
        phone = normalizePhone(await io.ask('手机号(带国家码,例如 +12025550123 / +8613800000000): '));
        if (!phone) io.log('  要以 + 开头带国家码,中间可以有空格');
    }
    const sendCode = () => client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId: Number(creds.apiId), apiHash: String(creds.apiHash), settings: new Api.CodeSettings({}) }));
    let sent;
    for (let tries = 0; ; tries++) {
        try { sent = await sendCode(); break; } catch (e) {
            if (errText(e) === 'AUTH_RESTART' && tries < 2) continue;
            throw fail('发验证码失败:' + zh(e));
        }
    }
    let sentAt = Date.now();
    const resend = async () => {
        try {
            sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash }));
            sentAt = Date.now();
            return true;
        } catch (e) {
            if (errText(e) === 'PHONE_CODE_EXPIRED') { try { sent = await sendCode(); sentAt = Date.now(); return true; } catch (e2) { io.log('  重发失败:' + zh(e2)); return false; } }
            io.log('  重发失败:' + zh(e));
            return false;
        }
    };
    for (let round = 0; round < 30; round++) {
        if (sent instanceof Api.auth.SentCodeSuccess) return sent.authorization.user;
        const d = describeSent(sent);
        if (d.kind === 'SentCodeTypeSetUpEmailRequired') {
            io.log('\nTelegram 要求这个号先绑定一个登录邮箱(以后这个号登录新设备的验证码会发到邮箱)。');
            const purpose = new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash });
            const email = await io.ask('输入一个你能收信的邮箱(直接回车 = 改用短信重发): ');
            if (!email) { if (!(await resend())) throw fail('没法发验证码'); continue; }
            let pattern;
            try { pattern = await client.invoke(new Api.account.SendVerifyEmailCode({ purpose, email })); } catch (e) { io.log('  ' + zh(e)); continue; }
            for (let k = 0; k < 5; k++) {
                const code = (await io.ask('邮箱 ' + ((pattern && pattern.emailPattern) || email) + ' 收到的验证码: ')).replace(/\s/g, '');
                try {
                    const v = await client.invoke(new Api.account.VerifyEmail({ purpose, verification: new Api.EmailVerificationCode({ code }) }));
                    if (v && v.sentCode) { sent = v.sentCode; sentAt = Date.now(); }
                    break;
                } catch (e) { io.log('  ' + zh(e)); if (k === 4) throw fail('邮箱验证没通过'); }
            }
            continue;
        }
        io.log('\n验证码发送方式:' + d.how);
        const left = Math.max(0, Math.ceil(d.timeout - (Date.now() - sentAt) / 1000));
        if (d.next) io.log('收不到的话输入 r,改用「' + d.next + '」重发' + (left ? '(Telegram 要求等 ' + left + ' 秒后才能重发)' : ''));
        else io.log('收不到的话输入 r 重发一次');
        if (!d.canUse) io.log('这种方式这里收不到,请输入 r 换一种');
        const input = await io.ask('验证码(r = 换方式重发,q = 放弃): ');
        if (/^q$/i.test(input)) throw fail('已放弃');
        if (!input) continue;
        if (/^r$/i.test(input)) { await resend(); continue; }
        const phoneCode = /SmsWord|SmsPhrase/.test(d.kind) ? input : input.replace(/[\s-]/g, '');
        let res;
        try {
            res = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash, phoneCode }));
        } catch (e) {
            const k = errText(e);
            if (k === 'SESSION_PASSWORD_NEEDED') return passwordLogin(client, creds, io);
            if (k === 'PHONE_CODE_INVALID' || k === 'PHONE_CODE_EMPTY') { io.log('  ' + zh(e) + ',再输一次'); continue; }
            if (k === 'PHONE_CODE_EXPIRED') { io.log('  ' + zh(e) + ',重发一个'); await resend(); continue; }
            throw fail('登录失败:' + zh(e));
        }
        if (res instanceof Api.auth.AuthorizationSignUpRequired) throw fail('这个手机号还没注册 Telegram(要先用官方 App 注册)');
        return res.user;
    }
    throw fail('试了太多次,先退出');
}

// 二步验证密码(扫码和验证码两条路都可能走到这)
function passwordLogin(client, creds, io) {
    return client.signInWithPassword({ apiId: Number(creds.apiId), apiHash: String(creds.apiHash) }, {
        password: (hint) => io.askHidden('二步验证密码' + (hint ? '(提示:' + hint + ')' : '') + ': '),
        // 返回 true = 不再重试
        onError: async (e) => {
            const k = errText(e);
            io.log('  ' + zh(e));
            return !(k === 'PASSWORD_HASH_INVALID' || k === 'Password is empty');
        },
    });
}

// 扫二维码登录:手机上这个号已经登录着 Telegram 就能用,完全不用验证码
async function qrLogin(client, creds, io) {
    const qrt = require('qrcode-terminal');
    let shown = 0;
    return client.signInUserWithQrCode({ apiId: Number(creds.apiId), apiHash: String(creds.apiHash) }, {
        qrCode: async ({ token }) => {
            const url = 'tg://login?token=' + Buffer.from(token).toString('base64url');
            shown++;
            io.log('\n' + (shown > 1 ? '二维码过期了,换了一个新的:' : '用手机扫下面这个二维码:'));
            qrt.generate(url, { small: true }, (s) => io.log(s));
            io.log('手机 Telegram → 设置 → 设备(Devices)→ 连接桌面设备(Link Desktop Device)→ 扫码');
            io.log('(30 秒左右换一次码;二维码显示不全就把终端窗口拉大,或者 Ctrl+C 退出改用验证码登录)');
        },
        password: (hint) => io.askHidden('这个号开了二步验证,输入密码' + (hint ? '(提示:' + hint + ')' : '') + ': '),
        onError: async (e) => {
            const k = errText(e);
            io.log('  ' + zh(e));
            return !(k === 'PASSWORD_HASH_INVALID' || k === 'Password is empty');
        },
    });
}

async function main() {
    const args = process.argv.slice(2);
    const list = readJson(FILE, []);
    const sessions = Array.isArray(list) ? list : [];
    if (args[0] === '--list') {
        if (!sessions.length) console.log('还没有账号。');
        for (const s of sessions) console.log('-', s.name, s.label ? '(' + s.label + ')' : '', s.addedAt ? '登录于 ' + s.addedAt.slice(0, 10) : '');
        return;
    }
    if (args[0] === '--remove') {
        const name = args[1];
        const rest = sessions.filter((s) => s.name !== name);
        if (rest.length === sessions.length) { console.log('没有叫', name, '的账号'); return; }
        writeJson(FILE, rest);
        console.log('已删除', name, ',剩', rest.length, '个账号。(要彻底注销,在手机 Telegram 设置 → 设备 里结束这个会话)');
        return;
    }

    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const { Logger, LogLevel } = require('telegram/extensions/Logger');
    let apiId = process.env.TG_API_ID, apiHash = process.env.TG_API_HASH;
    if (!apiId) apiId = await ask('TG_API_ID(my.telegram.org 申请的数字): ');
    if (!apiHash) apiHash = await ask('TG_API_HASH: ');
    if (!/^\d+$/.test(String(apiId)) || !apiHash) { console.log('api_id / api_hash 不对'); process.exitCode = 1; return; }
    const creds = { apiId: Number(apiId), apiHash: String(apiHash) };

    const dflt = 'a' + (sessions.length + 1);
    let name = (await ask('给这个账号起个名字(只用来区分,默认 ' + dflt + '): ')) || dflt;
    name = name.replace(/[^\w\-.一-鿿]/g, '').slice(0, 32) || dflt;
    console.log('\n登录方式:');
    console.log('  1) 扫二维码 —— 手机上这个号已经登录着 Telegram 就用这个,不用验证码(推荐)');
    console.log('  2) 手机号 + 验证码');
    const mode = (await ask('选 1 或 2(默认 1): ')) || '1';

    const client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, { connectionRetries: 3, baseLogger: new Logger(LogLevel.ERROR) });
    await client.connect();
    const io = { ask, askHidden, log: (s) => console.log(s) };
    let me;
    try {
        if (mode === '2') await codeLogin(client, creds, io);
        else await qrLogin(client, creds, io);
        me = await client.getMe();
    } catch (e) {
        await client.disconnect().catch(() => {});
        throw e;
    }
    const session = client.session.save();
    const uid = me && me.id ? me.id.toString() : '';
    const label = [me && me.firstName, me && me.username ? '@' + me.username : ''].filter(Boolean).join(' ');
    // 同一个 Telegram 账号重新登录 = 替换旧的
    const rest = sessions.filter((s) => s.name !== name && (!uid || s.uid !== uid));
    rest.push({ name, uid, label, session, addedAt: new Date().toISOString() });
    writeJson(FILE, rest);
    await client.disconnect().catch(() => {});
    console.log('\n已保存账号「' + name + '」' + (label ? '(' + label + ')' : '') + ',现在共 ' + rest.length + ' 个。');
    console.log('中转程序在跑的话 30 秒内会自动用上它,不用重启。');
}

module.exports = { normalizePhone, describeSent, codeLogin, zh };

if (require.main === module) {
    main().then(() => process.exit(process.exitCode || 0), (e) => { console.error('\n登录失败:', (e && e.zh) || zh(e)); process.exit(1); });
}
