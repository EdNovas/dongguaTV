#!/usr/bin/env node
'use strict';
// 登录 Telegram 账号给中转用(每个账号运行一次;手机号 / 验证码 / 二步验证密码只在这个终端里输入)
//   node login.js            登录一个新账号
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
    let apiId = process.env.TG_API_ID, apiHash = process.env.TG_API_HASH;
    if (!apiId) apiId = await ask('TG_API_ID(my.telegram.org 申请的数字): ');
    if (!apiHash) apiHash = await ask('TG_API_HASH: ');
    if (!/^\d+$/.test(String(apiId)) || !apiHash) { console.log('api_id / api_hash 不对'); process.exitCode = 1; return; }

    const dflt = 'a' + (sessions.length + 1);
    let name = (await ask('给这个账号起个名字(只用来区分,默认 ' + dflt + '): ')) || dflt;
    name = name.replace(/[^\w\-.一-鿿]/g, '').slice(0, 32) || dflt;

    const client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), { connectionRetries: 3 });
    client.setLogLevel('error');
    await client.start({
        phoneNumber: () => ask('手机号(带国家码,例如 +8613800000000): '),
        phoneCode: () => ask('Telegram 发来的验证码(在 Telegram App 里看): '),
        password: () => askHidden('二步验证密码(没设过就直接回车): '),
        onError: (e) => { console.log('出错:', (e && (e.errorMessage || e.message)) || e); },
    });
    const me = await client.getMe();
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

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error('登录失败:', (e && (e.errorMessage || e.message)) || e); process.exit(1); });
