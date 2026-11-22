'use strict';
// [adult] node -r 预加载:进程内答掉机场面板(v2board)的请求,全程不碰外网。面板域名/邮箱都是合成的(.test 保留域)。
//   只拦面板相关地址,其余请求(本机假 maccms 站)原样放行。
const axios = require('axios');
const PANEL = 'https://panel.example.test';
const EMAIL = 'viewer@example.test';
const og = axios.get.bind(axios), op = axios.post.bind(axios);
axios.get = async function (url, cfg) {
    const u = String(url);
    if (/\/domains\.json$/.test(u)) return { data: [PANEL] };
    if (u === PANEL + '/api/v1/user/getSubscribe') {
        const auth = cfg && cfg.headers && cfg.headers.Authorization;
        if (auth !== 'AUTH-OK') { const e = new Error('Request failed with status code 403'); e.response = { status: 403, data: { message: '未登录或登陆已过期' }, headers: {} }; throw e; }
        return { data: { data: { plan_id: 1, plan: { name: '测试套餐' }, expired_at: 0, u: 0, d: 0, transfer_enable: 0, email: EMAIL } } };
    }
    if (u.startsWith(PANEL)) throw new Error('unexpected panel GET ' + u);
    return og(url, cfg);
};
axios.post = async function (url, body, cfg) {
    const u = String(url);
    if (u === PANEL + '/api/v1/passport/auth/login') {
        if (body && body.email === EMAIL && body.password === 'pw') return { data: { data: { auth_data: 'AUTH-OK' } } };
        return { data: { data: null } };
    }
    if (u.startsWith(PANEL)) throw new Error('unexpected panel POST ' + u);
    return op(url, body, cfg);
};
