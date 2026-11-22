// [adult] 成人站内容层入口:分类体系 / 片名身份 / 内容硬过滤。
//
// server.js 直接 require('./lib/adult'),不要包 try/catch:
//   taxonomy.json 缺失或坏掉、正则编译失败、加载自检的金丝雀没拦住 —— 这里会 throw,服务器拒绝启动(fail-closed)。
//
//   const adult = require('./lib/adult');
//   adult.policy.checkQuery(q) / adult.policy.checkItem(item, ctx) / adult.policy.filterItems(items, ctxFn)
//   adult.taxonomy.classify(typeName, parentName) / adult.taxonomy.buildClassMap(classes, {host})
//   adult.title.parseTitle(name, typeName) / codeOk / searchVariants / workKey
//   adult.RULES_VERSION  → 进搜索/详情缓存键;变了后台重扫 adult_items
//   adult.tags.tagLine(rawItem, {site, parsed, cls}) / tagsFromAvdb(enTags) / mergeWork(lineTagLists, avdbTags)   [adult] phase 3 标签词表
'use strict';

const taxonomy = require('./taxonomy');
const title = require('./title');
const policy = require('./policy');
const tags = require('./tags');   // [adult] phase 3:逐条/逐作品标签(tag-vocab.json,进 RULES_VERSION 指纹)

module.exports = { policy, taxonomy, title, tags, RULES_VERSION: policy.RULES_VERSION };
