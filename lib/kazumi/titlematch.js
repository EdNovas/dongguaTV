// 标题归一化/分组吸附的唯一真源在 public/libs/js/kz-titlematch.js(UMD:浏览器 <script> 与 Node require 共用)。
// 这里只做转发,让 server.js / api/index.js 用相对 require 引入(Vercel 的 nft 依赖追踪能跟到静态 require 路径)。
module.exports = require('../../public/libs/js/kz-titlematch.js');
