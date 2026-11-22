'use strict';
// [adult] node -r 预加载:把 server.js 的 require('./lib/site-catalog') 换成 ADULT_TEST_CATALOG_STUB 指向的替身。
//   不在 server.js 里留任何测试开关;没设 ADULT_TEST_CATALOG_STUB 时什么都不做。
const Module = require('module');
const stub = process.env.ADULT_TEST_CATALOG_STUB;
if (stub) {
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (/(^|[\\/])lib[\\/]site-catalog([\\/]index(\.js)?)?$/.test(String(request))) return stub;
        return orig.call(this, request, parent, isMain, options);
    };
}
