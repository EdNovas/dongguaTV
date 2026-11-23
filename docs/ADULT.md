# 成人版（adult 分支）部署与运维说明

> 这份文档只在 `adult` 分支里。代码层面更细的说明见 `lib/adult-gate/index.js` 顶部注释（各阶段新增的接口、环境变量都列在那里）。

## 一、部署前必须知道的

- **不要推到公开仓库、不要打 tag**：公开仓库的 GitHub Actions 会把 main 打成 `ednovas/dongguatv:latest`；成人分支已经删掉了 docker-publish / android-build 两个 workflow，但仍不要推到同一个公开远端。
- **内容硬过滤不可配置**：未成年、偷拍盗摄、迷奸/下药/外力致昏、换脸、真人私密泄露、人兽，任何开关都关不掉；后台只能让规则更严（追加屏蔽词、隐藏作品、停用资源站）。
- **源站列表不在 git 里**：`db.adult.json`（30 个启用后端，带 `mirrors` 备用域名；辣椒资源 av_s14 整站封面图床已死，标了 `active:false`）在本机 `.adult-research/` 下。部署时把它拷到服务器，用 `DB_FILE=/path/to/db.adult.json` 指过去（或改名成 `db.json` 放在项目根目录，`db.json` 本来就被 gitignore）。

## 二、aaPanel（宝塔）Node 项目

1. 把仓库拷到服务器（不要拷 `node_modules/`、`.git/`、`.adult-research/` 整个目录），然后 `npm ci --omit=dev`。
2. Node 版本用 22 或 24（与主站一致）。**命令行里的 `node` 常常不是宝塔给项目用的那个**（Ubuntu 20.04 自带的 `/usr/bin/node` 是 v10，用它装 better-sqlite3 会报 `-std=c++20` 编译失败，而且会把原来装好的删掉）。`npm ci` / `npm rebuild` 之前先把宝塔的 Node 放到最前面：`export PATH=/www/server/nodejs/v24.12.0/bin:$PATH`（版本号按项目设置里选的改），`node -v` 确认一下。
3. `.env` 至少要有：

```ini
PORT=3000
ACCESS_PASSWORD=换成你的访问密码        # 不配 = 公开站（只有年龄确认），不建议
DB_FILE=/www/wwwroot/dgx/db.adult.json
CACHE_TYPE=sqlite
CACHE_DB_PATH=/www/wwwroot/dgx-data/cache.db   # catalog.db / adult-admin.json / adult-mirror.json 默认都放在它旁边
ADULT_CORS_PROXY_URL=https://你自己的成人站worker.workers.dev   # 见第四节；不要复用主站的 Worker
ADULT_CLIENT_IP_HEADER=x-real-ip                # nginx 反代必配；前面还有 Cloudflare 时用 cf-connecting-ip
ADULT_ADMIN_TOKEN=至少16位的随机串               # 后台 /admin/adult；不配就不开后台
```

4. 数据目录放在项目目录之外（上面的 `/www/wwwroot/dgx-data/`），这样更新代码时不会被覆盖。
5. **改了 `public/index.html` 要重启 Node**：服务器把首页缓存在内存里。

### Docker

不要用公开的 `ednovas/dongguatv` 镜像（那是主站）。自己从 adult 分支 `docker build`，并把 `CACHE_DB_PATH` 指到挂载卷里，例如 `-v /srv/dgx-data:/data -e CACHE_DB_PATH=/data/cache.db`。`catalog.db`（十几万部作品，几百 MB）不挂卷的话，每次重建容器都要从头爬一遍。

## 三、环境变量一览（成人版专用）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ADULT_CORS_PROXY_URL` | 空 | 成人站自己的 CORS / 去广告 Worker（可逗号分隔多个）。只配了 `CORS_PROXY_URL` 会被忽略（防止用到主站的 Worker）。**不配就不去插播广告** |
| `ADULT_CLIENT_IP_HEADER` | 空 | 反代写入的可信客户端 IP 头。**反代后面必须配**：不配时所有人共用一个客户端键，①任何人连输 5 次错的后台令牌就能把站长锁在外面 10 分钟；②线路"失效"判定、播放上报限流、热度防刷都分不清人。不配时客户端自己带的 `X-Forwarded-For` / `X-Real-IP` 等头一律不认，只看直连对端（IPv6 按 /64 算一个）：对端是内网/本机或 Cloudflare 回源地址 = 认不出（共用一个键）；放在公网地址上的自建反代没配这个头 = 整个反代算一个客户端 |
| `ADULT_ADMIN_TOKEN` | 空 | 后台令牌（≥16 字符）。没配时退回 `ADMIN_TOKEN`；设成 `off` 关掉成人后台 |
| `ADULT_MIRROR_DISABLE` | 空 | `=1` 关掉"资源站换域名自动跟随" |
| `ADULT_IMG_PROXY` | 空 | `=1` 开封面代理 `/api/img`（默认海报直链 + no-referrer） |
| `ADULT_IMG_CACHE_MB` / `ADULT_IMG_CACHE_DIR` | 1024 / cache.db 旁 | 封面磁盘缓存（不许放在 public/ 里） |
| `ADULT_COVER_HEALTH_DISABLE` | 空 | `=1` 关掉"封面图床健康检查"（见下）：不查 DNS，已判死的图床当活的，作品封面挑回原样、不再因此隐藏（`0`/`false`/`no`/`off`/空 = 没关） |
| `ADULT_COVER_HEALTH_DELAY_MS` | 600000 | 启动后多久做第一轮封面图床检查（之后每 6 小时一轮） |
| `ADULT_COVER_SERVFAIL_DEAD` | 开 | **默认开**：持续 SERVFAIL 的图床也算死（区被删掉的域名对所有人都打不开，见下；`=0`/`false`/`no`/`off` 关掉 → 只认 NXDOMAIN；空 = 没设 = 开） |
| `PURCHASE_URL` | `https://ednovas.me` | 登录页"购买/续费"链接，默认沿用主站；填别的 http(s) 地址就换掉，填 `off` 就不显示 |
| `CATALOG_DB_PATH` | cache.db 旁的 catalog.db | 目录库 |
| `CATALOG_BACKFILL` | 开 | `=0` 关全量历史回填（每站间隔 ≥2.2 秒慢慢爬） |
| `CATALOG_SHORT_BACKFILL` | 开 | `=0` 关短视频分类的慢速补库（"刷一刷"的片源池） |
| `CATALOG_WORKERS` | 开 | `=0` 目录不开工作线程（只用于调试） |
| `CATALOG_EXT_HOT_SITE` | av_s31 | "外站热门"行取哪个站的周点击 |
| `AVDB_DISABLE` / `AVDB_FIRST_DELAY_MS` / `AVDB_MAX_PAGES` | — | AVDB（番号元数据）同步 |

**封面图床健康检查**（目录自带，默认开）：资源站的封面图床常常整个没了（域名过期 / 注销 / 解析服务停了），那些作品的卡片会一直是灰的。服务器每 6 小时查一次目录里所有封面图床的 DNS（只查 DNS，从不下载图片；c-ares 解析器，并发 ≤8，一个查询总共约 5 秒）。判"死"只认对所有人都一样的结果：

- **NXDOMAIN**：A 和 AAAA 都回"不存在"、两次检查隔 ≥10 分钟都这样（第二次是 15 分钟后单独复查，顺带查几个上一轮正常的图床当对照）。
- **SERVFAIL**（`ADULT_COVER_SERVFAIL_DEAD=0` 可关）：域名注册着、但解析服务器不应答或拒答（例如域名还指着 Cloudflare、区已经删了——实测有个图床就是这样，背后是一整个站的封面，所有公共解析器都回 SERVFAIL，从来不是 NXDOMAIN）。要 A / AAAA 都 SERVFAIL、关掉 DNSSEC 校验（CD 位）再问一遍还是 SERVFAIL（排除"DNSSEC 签坏了"——那种不校验的解析器照样解析得出，用户还能看），而且在每 6 小时的全量检查里连续 ≥3 次、跨 ≥24 小时。
- 超时、拒绝、解析器连不上一律当"不知道"，不判死。解析器本身不正常的那一轮整轮不算：解析出地址的图床少于 3 个、或"不存在"超过明确答复的 30%（劫持 / 过滤 / 断网时的假应答）；复查轮看对照图床（≥3 个、≥70% 解析正常才算数）。这个比例只算这一轮之前还没判死的图床——早就死了的照样每轮复查，但不算进比例（否则死图床一多就再也判不出新死的，还每 6 小时报一次"解析器有问题"）。
- 首轮（启动 10 分钟后）赶上目录库还没好或者出错，约 5 分钟后重试，不等 6 小时。

死图床上的封面不再被选作作品封面（换成同一部作品在别的活图床上的封面，卡片另带最多 2 个候补地址 `alt`；开了封面代理 `ADULT_IMG_PROXY` 时卡片没有 `alt`，由 `/api/img` 按"挑中的那条线路封面 → 候补 → AVDB 封面"的顺序在服务器上换，死图床上的一律不取；一个能取的地址都没有回 404，有地址但上游都取不到回 502）；一张活封面都没有的作品不出现在首页、浏览、分面计数、标签页、相关推荐、演员页里，但作品页、搜索、"刷一刷"照常。死图床每轮照样复查，解析得出地址就立刻恢复。状态存在 catalog.db 里，重启不丢；死图床名单通过 `/api/config` 的 `cover_dead_hosts` 给前端（只给能看目录的请求：要登录的站要带令牌，公开站要确认过年龄；前端对现搜结果的封面也先跳过它们）。网络慢、图片加载慢不影响这里——这里只看对所有人都一样的 DNS 结果。

本分支默认关掉：直播、番剧规则站、弹幕（会把片名发给第三方）、Web Push（锁屏通知会露片名）、求片、片头学习、分享试看、分享卡片页。都可以用对应的 `*_DISABLE=0` 重新打开，但不建议。

## 四、CORS / 去广告 Worker

成人站要单独部署一个 Worker（同一份 `cloudflare-cors-proxy.js`，成人分支里的版本带了针对 2609 系插播的补丁 D/E/F/G），用另一个 Cloudflare 账号更好。部署后把地址填进 `ADULT_CORS_PROXY_URL`。

## 五、后台（站长后台 `/admin` 的「片库管理」页签）

- 成人站的后台并进了站长后台：打开 `/admin`，用 `ADMIN_TOKEN` 登录，最后一个页签「片库管理」就是它（同一个令牌，不用再输）。旧地址 `/admin/adult` 会转到 `/admin#adult`。
- 建议只配一个随机的 `ADMIN_TOKEN`、不单独配 `ADULT_ADMIN_TOKEN`（没配时就用 `ADMIN_TOKEN`）。两个配成不同的值也行，那「片库管理」里会再要一次成人后台的令牌。只配了 `ADULT_ADMIN_TOKEN`、没配 `ADMIN_TOKEN` 时，`/admin/adult` 照旧是单独一页。
- 令牌放在请求头 `X-Admin-Token` 里，不接受 `?token=`。
- 六个页签：概览（含「片库历史回填」进度：已翻页数、翻完的站、预计还要多久）、规则测试（输入片名看会不会被拦）、附加屏蔽词、隐藏作品、资源站（停用/启用）、镜像（看/手动探测各站当前域名；"回到主地址"立刻切回主域名，正在进行的自动切换也会作废）。
- 镜像自动跟随：页面里找到的新域名只认和原域名相像的；没在配置里的新域名必须按片名 / vod_id 对得上最近的片子才切过去（只看分类表不算）。升级后旧的 `adult-mirror.json` 快照会丢弃一次，等主域名下一次抽样重建，在那之前只认配置好的镜像。
- 附加屏蔽词：保存后立即在所有出口生效；目录在后台删除命中的线路。**删词不会马上恢复已删的线路**，要等之后抓取或搜索重新收录。
- 状态文件 `adult-admin.json`（停用的站、追加词、热度盐种子）和 `adult-mirror.json`（各站当前域名）在 cache.db 旁边，已在 .gitignore / .dockerignore 里。

## 六、隐私相关（前端，用户自己在"设置 → 隐私"里开）

老板键（默认 `` ` ``，也可 Esc 连按两下 / F9）、无痕模式（不记历史、不上报）、PIN 锁（4–6 位，PBKDF2；忘记 PIN = 退出登录并清空本机数据）、标签伪装（标题/图标伪装成文档、搜索、邮箱）、一键清除（连同服务器上的观看记录和删除记录一起清；只管本机和云端，别的设备本地留着的删除记录下次同步还会推回去）。关掉无痕会刷新一次页面（内存里的东西不落盘）；无痕时仍可以从"继续观看"里删条目。

## 七、Android（可选）

见 `.adult-research/impl/p4/android-build.md`（本机文件，不在 git 里）。要点：签名 keystore 必须你自己生成、放在仓库外；`capacitor.config.json` 里的 `server.url` 要改成你的私有域名；APK 只走 HTTPS、不信任用户自装证书、默认禁止截屏（设置里可关）。
