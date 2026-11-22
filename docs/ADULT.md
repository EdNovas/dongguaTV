# 成人版（adult 分支）部署与运维说明

> 这份文档只在 `adult` 分支里。代码层面更细的说明见 `lib/adult-gate/index.js` 顶部注释（各阶段新增的接口、环境变量都列在那里）。

## 一、部署前必须知道的

- **不要推到公开仓库、不要打 tag**：公开仓库的 GitHub Actions 会把 main 打成 `ednovas/dongguatv:latest`；成人分支已经删掉了 docker-publish / android-build 两个 workflow，但仍不要推到同一个公开远端。
- **内容硬过滤不可配置**：未成年、偷拍盗摄、迷奸/下药/外力致昏、换脸、真人私密泄露、人兽，任何开关都关不掉；后台只能让规则更严（追加屏蔽词、隐藏作品、停用资源站）。
- **源站列表不在 git 里**：`db.adult.json`（31 个启用后端，带 `mirrors` 备用域名）在本机 `.adult-research/` 下。部署时把它拷到服务器，用 `DB_FILE=/path/to/db.adult.json` 指过去（或改名成 `db.json` 放在项目根目录，`db.json` 本来就被 gitignore）。

## 二、aaPanel（宝塔）Node 项目

1. 把仓库拷到服务器（不要拷 `node_modules/`、`.git/`、`.adult-research/` 整个目录），然后 `npm ci --omit=dev`。
2. Node 版本用 22（与主站一致）。
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
| `ADULT_CLIENT_IP_HEADER` | 空 | 反代写入的可信客户端 IP 头。**反代后面必须配**：不配时所有人共用一个客户端键，①任何人连输 5 次错的后台令牌就能把站长锁在外面 10 分钟；②线路"失效"判定、播放上报限流、热度防刷都分不清人 |
| `ADULT_ADMIN_TOKEN` | 空 | 后台令牌（≥16 字符）。没配时退回 `ADMIN_TOKEN`；设成 `off` 关掉成人后台 |
| `ADULT_MIRROR_DISABLE` | 空 | `=1` 关掉"资源站换域名自动跟随" |
| `ADULT_IMG_PROXY` | 空 | `=1` 开封面代理 `/api/img`（默认海报直链 + no-referrer） |
| `ADULT_IMG_CACHE_MB` / `ADULT_IMG_CACHE_DIR` | 1024 / cache.db 旁 | 封面磁盘缓存（不许放在 public/ 里） |
| `PURCHASE_URL` | 空 | 登录页"购买/续费"链接；不配就不显示 |
| `CATALOG_DB_PATH` | cache.db 旁的 catalog.db | 目录库 |
| `CATALOG_BACKFILL` | 开 | `=0` 关全量历史回填（每站间隔 ≥2.2 秒慢慢爬） |
| `CATALOG_SHORT_BACKFILL` | 开 | `=0` 关短视频分类的慢速补库（"刷一刷"的片源池） |
| `CATALOG_WORKERS` | 开 | `=0` 目录不开工作线程（只用于调试） |
| `CATALOG_EXT_HOT_SITE` | av_s31 | "外站热门"行取哪个站的周点击 |
| `AVDB_DISABLE` / `AVDB_FIRST_DELAY_MS` / `AVDB_MAX_PAGES` | — | AVDB（番号元数据）同步 |

本分支默认关掉：直播、番剧规则站、弹幕（会把片名发给第三方）、Web Push（锁屏通知会露片名）、求片、片头学习、分享试看、分享卡片页。都可以用对应的 `*_DISABLE=0` 重新打开，但不建议。

## 四、CORS / 去广告 Worker

成人站要单独部署一个 Worker（同一份 `cloudflare-cors-proxy.js`，成人分支里的版本带了针对 2609 系插播的补丁 D/E/F/G），用另一个 Cloudflare 账号更好。部署后把地址填进 `ADULT_CORS_PROXY_URL`。

## 五、后台 `/admin/adult`

- 只在配了令牌时存在（没配 = 404）；令牌放在请求头 `X-Admin-Token` 里，不接受 `?token=`。
- 六个页签：概览、规则测试（输入片名看会不会被拦）、附加屏蔽词、隐藏作品、资源站（停用/启用）、镜像（看/手动探测各站当前域名）。
- 附加屏蔽词：保存后立即在所有出口生效；目录在后台删除命中的线路。**删词不会马上恢复已删的线路**，要等之后抓取或搜索重新收录。
- 状态文件 `adult-admin.json`（停用的站、追加词、热度盐种子）和 `adult-mirror.json`（各站当前域名）在 cache.db 旁边，已在 .gitignore / .dockerignore 里。

## 六、隐私相关（前端，用户自己在"设置 → 隐私"里开）

老板键（默认 `` ` ``，也可 Esc 连按两下 / F9）、无痕模式（不记历史、不上报）、PIN 锁（4–6 位，PBKDF2；忘记 PIN = 退出登录并清空本机数据）、标签伪装（标题/图标伪装成文档、搜索、邮箱）、一键清除。

## 七、Android（可选）

见 `.adult-research/impl/p4/android-build.md`（本机文件，不在 git 里）。要点：签名 keystore 必须你自己生成、放在仓库外；`capacitor.config.json` 里的 `server.url` 要改成你的私有域名；APK 只走 HTTPS、不信任用户自装证书、默认禁止截屏（设置里可关）。
