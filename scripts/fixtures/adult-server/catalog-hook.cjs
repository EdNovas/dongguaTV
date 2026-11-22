'use strict';
// [adult] node -r 预加载:把 server.js 的 require('./lib/site-catalog') 换成 ADULT_TEST_CATALOG_STUB 指向的替身;
//   第四阶段:require('./lib/adult-mirror') 换成 ADULT_TEST_MIRROR_STUB(闸门里的 require('../adult-mirror') 不换:它只用 classifyError)。
//   不在 server.js 里留任何测试开关;没设这两个变量时什么都不做。
const Module = require('module');
const stub = process.env.ADULT_TEST_CATALOG_STUB;
const mstub = process.env.ADULT_TEST_MIRROR_STUB;
if (stub || mstub) {
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (stub && /(^|[\\/])lib[\\/]site-catalog([\\/]index(\.js)?)?$/.test(String(request))) return stub;
        if (mstub && /(^|[\\/])lib[\\/]adult-mirror([\\/]index(\.js)?)?$/.test(String(request))) return mstub;
        return orig.call(this, request, parent, isMain, options);
    };
}
