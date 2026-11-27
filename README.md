# E视界

影视聚合播放器：TMDb 提供资料，多个 Maccms 采集站提供播放源。Node.js + Express + Vue 3。

最早从 [Minerchu/dongguaTV](https://github.com/Minerchu/dongguaTV)（冬瓜TV）起步，现已整体重写，主要增加：两级去广告、按广告情况分组的线路、跳过片头片尾、弹幕与评论、刷短剧、直播、离线缓存、多用户同步、站长后台、TV 模式与 Android App。

**演示**：https://ednovas-test.vercel.app （不含任何数据）

<img width="2547" height="1226" alt="image" src="https://github.com/user-attachments/assets/15392a90-9078-45b6-828d-829402669950" />

<img width="2547" height="1227" alt="image" src="https://github.com/user-attachments/assets/d03543f5-34a4-414b-a131-62eda0af21b2" />

<img width="2547" height="1229" alt="image" src="https://github.com/user-attachments/assets/e8bd4e14-dbd2-4d49-a1fc-7979c1ca22a4" />

---

## 目录

1. [功能一览](#功能一览)
2. [快速开始](#快速开始)：[准备](#1-准备) · [部署](#2-部署) · [环境变量](#3-环境变量)
3. [可选组件](#可选组件)：[CORS 代理](#cors-代理) · [TMDB 反代](#tmdb-反代) · [弹幕服务](#弹幕服务-danmu_api)
4. [功能说明](#功能说明)
   - 找片：[搜索与首页](#搜索与首页) · [短剧](#短剧)
   - 播放：[线路](#线路分组与自动选源) · [去广告](#去广告) · [播放器](#播放器) · [跳过片头片尾](#跳过片头片尾) · [离线缓存](#离线缓存)
   - 互动：[弹幕](#弹幕) · [评论](#评论与用户弹幕) · [收藏与片单](#收藏片单与推送) · [分享](#分享与-seo)
   - 其它：[直播](#直播-iptv) · [账号与同步](#账号与同步) · [站长后台](#站长后台) · [外观与 TV 模式](#外观tv-模式与偏好设置)
5. [Android App](#android-app)
6. [数据与备份](#数据与备份)
7. [开发与测试](#开发与测试)
8. [致谢与免责声明](#致谢)

---

## 功能一览

**找片**
- TMDb 海报、评分、简介；多个采集站聚合，边搜边出结果
- 关键词变体、英文名转中文名；同名不同作品自动拆卡
- 语音搜索、AI 找片（描述剧情、演员、台词或截图）
- 内置 4 个番剧源；关了搜索的采集站走本地片名索引

**首页**
- 趋势轮播、20 个榜单、继续观看、我的收藏、为你推荐、大家都在看
- 追剧日历（一周更新表）、自选分类行、片单

**短剧**
- 竖屏刷：上下滑换部，按住两侧倍速，长按中间进播放器页
- 「短剧」分类：按题材、热度浏览全部短剧

**播放**
- 线路按「有没有广告」分组，实测分辨率角标，失败自动换线
- 两级去广告：Worker 边缘剔除 + 播放器开播前剪掉插播
- 跳过片头片尾（自动学习、全站共享）、进度条缩略图
- 倍速、进度记忆、自动下一集、画中画、投屏、手势、离线缓存

**互动**
- 弹幕（平台弹幕 + 用户弹幕）、评论区
- 收藏追剧、更新提醒、推送通知、片单、截帧分享

**其它**
- 直播：约 1800 个频道，语言 × 种类筛选
- 账号：多密码多用户、扫码登录、跨设备同步、求片
- 站长后台：观看统计、用户、求片、评论、AI 模型
- 多端：PWA、Android App、TV 模式；5 种主题风格 × 明暗

> 部分功能需要服务器和 SQLite，**Vercel 部署不支持**，见 [Vercel 的限制](#vercel)。

---

## 快速开始

### 1. 准备

**TMDb API Key（必需）**

注册 [TMDb](https://www.themoviedb.org/signup) → [API 设置](https://www.themoviedb.org/settings/api) 申请（类型选 Developer）→ 复制 **API Key (v3 auth)**。

**采集源（必需）**

本项目**不内置**任何资源接口。自备合法的 Maccms V10 JSON 接口，写进 `db.json`（首次运行会由 `db.template.json` 生成占位）：

```json
{
  "sites": [
    { "key": "site1", "name": "站点名称", "api": "https://example.com/api.php/provide/vod/" }
  ]
}
```

- 停用站点只能删除（`active` 字段不生效）。
- `ad_tier` / `profile`：覆盖线路分组，见[线路](#线路分组与自动选源)。
- `search: false` / `true`：强制走 / 不走片名索引。
- `shorts_types`：短剧放在认不出来的分类里时手动指定，如 `"96-116"`（追加）、`"=24,50"`（只用这些）。
- 远程加载：`REMOTE_DB_URL`（5 分钟缓存，失败回退本地）；Vercel 用 `SITES_JSON`。

### 2. 部署

**要求**

- Node.js **22 或 24**（18、20 已停止维护）。
- 要用同步、求片、评论、短剧、后台等功能，设 **`CACHE_TYPE=sqlite`**。

#### Docker（推荐）

镜像 `ednovas/dongguatv:latest`（或 `ghcr.io/ednovas/dongguatv:latest`），支持 amd64 / arm64 / armv7。

```bash
# 先建好文件，否则 Docker 会把它们当目录挂载（报 EISDIR）
touch cache.db && echo '{"sites":[]}' > db.json && mkdir -p cache/images

docker run -d --name donggua-tv --restart unless-stopped -p 3000:3000 \
  -e TMDB_API_KEY="your_api_key" \
  -e CACHE_TYPE=sqlite \
  -e ACCESS_PASSWORD="main_pw,user1_pw,user2_pw" \
  -e ADMIN_TOKEN="a_long_random_string" \
  -e CORS_PROXY_URL="https://cors-proxy.your-name.workers.dev" \
  -v $(pwd)/db.json:/app/db.json \
  -v $(pwd)/cache.db:/app/cache.db \
  -v $(pwd)/cache/images:/app/public/cache/images \
  ednovas/dongguatv:latest
```

<details>
<summary>Docker Compose / 本地构建</summary>

```yaml
services:
  donggua-tv:
    image: ednovas/dongguatv:latest
    container_name: donggua-tv
    ports: ["3000:3000"]
    environment:
      - TMDB_API_KEY=your_api_key
      - CACHE_TYPE=sqlite
      - ACCESS_PASSWORD=main_pw,user1_pw
      - ADMIN_TOKEN=a_long_random_string
      - CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev
    volumes:
      - ./db.json:/app/db.json
      - ./cache.db:/app/cache.db
      - ./cache/images:/app/public/cache/images
    restart: unless-stopped
```

本地构建：`docker build -t donggua-tv .`。`.dockerignore` 不排除 `db.json`、`cache.db`，构建前请移走，免得打进镜像。
</details>

- **重建容器前先 `docker stop`**：SQLite 用 WAL 模式，最近的写入可能还在 `cache.db-wal` 里。
- **更新**：`docker pull ednovas/dongguatv:latest` → `docker stop donggua-tv && docker rm donggua-tv` → 重新创建。Compose：`docker compose pull && docker compose up -d`。

#### 一键脚本

```bash
curl -fsSL https://raw.githubusercontent.com/ednovas/e-show/main/install.sh | bash
```

脚本会询问 TMDb Key、反代、端口、缓存类型、访问密码、安装目录，用 PM2 启动（进程名 `donggua-tv`）。CORS 代理、弹幕、站长令牌之后在 `.env` 里补。

#### 手动 / PM2 / 宝塔

```bash
git clone https://github.com/ednovas/e-show.git && cd e-show
npm install                          # 无预编译包时需 build-essential python3
cp .env.example .env && nano .env    # 至少填 TMDB_API_KEY
node server.js                       # 或 pm2 start server.js --name donggua-tv
```

宝塔：装 Node.js 版本管理器（22 或 24）→ 网站 → Node 项目 → 添加，启动文件 `server.js`、端口 `3000`，配好 `.env` 后重启。

#### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fednovas%2Fe-show&env=TMDB_API_KEY,SITES_JSON,REMOTE_DB_URL,ACCESS_PASSWORD,TMDB_PROXY_URL&envDescription=TMDB_API_KEY%20is%20required.%20Use%20SITES_JSON%20(Base64)%20or%20REMOTE_DB_URL%20for%20site%20config.&envLink=https%3A%2F%2Fgithub.com%2Fednovas%2Fe-show%23vercel)

填 `TMDB_API_KEY`，以及 `SITES_JSON`（db.json 内容，JSON 或 Base64）或 `REMOTE_DB_URL`。改变量后要 **Redeploy**。

<a id="vercel"></a>**Vercel 的限制**（无状态，只跑 `api/index.js`）：

| 缺少 | 原因 |
|---|---|
| 同步、求片、评论、站长后台、观看统计 | 没有 SQLite |
| 边缘去广告；iOS 开播前剪插播退化为播放中跳过 | `CORS_PROXY_URL` 不生效 |
| 刷短剧、追剧日历、片名索引、收藏更新检查 | 没有后台定时任务 |
| 直播、片头标记共享、分享卡片、SEO 页、sitemap | 未移植 |
| 关键词变体、英文转中文、搜索缓存 | 未移植 |

要完整功能请用 VPS / Docker。

### 3. 环境变量

只有 `TMDB_API_KEY` 必填。布尔开关认 `1/true/yes/on`，填 `0/false` 等于没开。

**基础**

| 变量 | 默认 | 说明 |
|---|---|---|
| `TMDB_API_KEY` | — | **必填**，TMDb v3 Key |
| `PORT` | `3000` | 监听端口 |
| `CACHE_TYPE` | `json` | `sqlite`（推荐）/ `json` / `memory` / `none`。SQLite 起不来时退回 `memory` |
| `ACCESS_PASSWORD` | — | 访问密码，逗号分隔多个：第 1 个是共用主密码（不同步），其余每个是独立用户 |
| `ADMIN_TOKEN` | — | 站长令牌。设了才有 `/admin` 后台和求片 |
| `SITE_URL` | 按请求推断 | 分享卡片、SEO、sitemap 用的站点地址 |
| `SHARE_TRIAL_MINUTES` | `5` | 未登录打开分享链接可试看几分钟；`0` = 不试看 |

**采集源与网络**

| 变量 | 默认 | 说明 |
|---|---|---|
| `REMOTE_DB_URL` | — | 远程 db.json |
| `SITES_JSON` | — | 仅 Vercel：站点配置（JSON 或 Base64），优先于 `REMOTE_DB_URL` |
| `CORS_PROXY_URL` | — | Cloudflare Worker 代理，**去广告和直播都靠它**。逗号分隔多个，第一个为主 |
| `TMDB_PROXY_URL` | — | TMDB 反代，大陆访客自动走 |
| `SERVER_IN_CHINA` | — | `true` = 服务器自己的 TMDB 请求也走反代 |
| `TITLE_INDEX_DISABLE` | — | 关闭片名索引（见[搜索](#搜索与首页)） |
| `TITLE_INDEX_DB` | `./title-index.db` | 片名索引位置，纯缓存 |

**首页与短剧**

| 变量 | 默认 | 说明 |
|---|---|---|
| `CALENDAR_DISABLE` | — | 关闭追剧日历 |
| `CALENDAR_SITES` | 自动 | 追剧日历的数据源，填站点 key，逗号分隔 |
| `SHORTS_DISABLE` | — | 关闭刷短剧和短剧分类 |
| `SHORTS_SITES` | 自动 | 短剧用哪些站，填站点 key。默认自动识别有短剧分类的站 |
| `SHORTS_SITES_FILE` | `./shorts-sites.json` | 只给短剧用的站（格式同 db.json），不进普通搜索 |

**AI**（Cloudflare Workers AI）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CF_AI_ACCOUNT_ID` / `CF_AI_TOKEN` | — | 账户 ID 与 Workers AI Token。配了才有语音搜索（Whisper）、AI 找片、评论 AI 审核 |
| `CF_AI_DAILY_LIMIT` | `3000` | 全站每天最多调用几次 |
| `CF_AI_FIND_MODEL` | — | AI 找片默认文字模型；后台选了以后台为准 |
| `VOICE_DISABLE` | — | 只关语音搜索 |
| `AI_FIND_DISABLE` | — | 只关 AI 找片 |
| `COMMENT_AI_REVIEW` | 开 | `0` = 评论只用屏蔽词，不过 AI |
| `COMMENT_AI_DAILY_LIMIT` | 总额度一半 | 评论审核每天最多几次 |

**弹幕与评论**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DANMU_API_URL` | — | 自建 danmu_api 地址，设了才有平台弹幕；逗号分隔多个并行 |
| `DANMU_API_TOKEN` | — | 对应令牌，按顺序配对，只填一个则共用 |
| `DANMU_API_SINGLE_INSTANCE` | — | 声明 danmu_api 只有一个实例（自己的 Docker），多实例别开 |
| `DANMAKU_CACHE_DAYS` | `7` | 服务器缓存一集弹幕几天 |
| `COMMENTS_DISABLE` | — | 关闭评论和用户弹幕 |

**直播**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVE_TV_DISABLED` | — | 关闭直播 |
| `LIVE_M3U_URL` / `LIVE_M3U_FALLBACK` | 内置 | 主源 / 备源 |
| `LIVE_M3U_IPTVORG` / `LIVE_M3U_ZHO` | iptv-org | 中文 / 华语补充源 |
| `LIVE_M3U_EXTRA` | — | 自定义 M3U，逗号分隔 |
| `LIVE_M3U_DISABLE` | — | 关闭所有内置源，只留 `EXTRA` / `ADULT` |
| `LIVE_M3U_ADULT` | — | 成人直播源（不内置），受成人过滤开关控制 |
| `LIVE_NO_VALIDATE` | — | 跳过服务器的频道可达性测试 |

**其它开关**

| 变量 | 默认 | 说明 |
|---|---|---|
| `KAZUMI_DISABLE` | — | 关闭内置番剧源 |
| `KAZUMI_SITES` | 全部 | 只启用指定番剧源：`7sefun,dm84,moonci,xfdm` |
| `HLS_CUT_DISABLE` | — | 关闭剪后清单托管（iOS 开播前剪插播要它） |
| `STATS_DISABLE` | — | 关闭观看与分享统计（「大家都在看」随之消失） |
| `FAV_CHECK_DISABLE` | — | 关闭收藏的更新检查 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 自动生成 | 推送密钥。一般不填；换服务器想保留订阅时才填 |
| `VAPID_SUBJECT` | `SITE_URL` | 推送联系方式，一般不填 |

---

## 可选组件

### CORS 代理

浏览器直连资源站失败时经代理中转。**边缘去广告、直播、服务器测速都依赖它。**

**部署**

1. Cloudflare → Workers & Pages → Create Worker，粘贴 `cloudflare-cors-proxy.js` → Deploy。
2. `.env` 配 `CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev`（可再部署一个做备用）。

**注意**

- 免费版每天 10 万次请求，自用足够。
- 改了 `cloudflare-cors-proxy.js` 要回 Dashboard 重新部署，网站更新不会带上 Worker。
- `proxy-server.js` 是最简 Node 版：**只转发、不去广告**，输出 `http://` 地址（HTTPS 站点上要再套 HTTPS），它的 `PROXY_PASSWORD` 前端不会发送，设了会全部 403。

### TMDB 反代

大陆访问不了 TMDB：部署 `cloudflare-tmdb-proxy.js` 为 Worker，配 `TMDB_PROXY_URL`；服务器在大陆再加 `SERVER_IN_CHINA=true`。

### 弹幕服务 danmu_api

平台弹幕来自自建的 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api)（兼容弹弹play，聚合爱奇艺、腾讯、优酷、B站、芒果等）。需要 **v1.20.10 及以上**。推荐自己的 VPS 跑 Docker：

```bash
docker run -d --name danmu-api --restart unless-stopped -p 127.0.0.1:9321:9321 \
  -e TOKEN=your_token -e RATE_LIMIT_MAX_REQUESTS=0 \
  -e SOURCE_ORDER=360 -e PLATFORM_ORDER=qiyi,qq \
  -v /opt/danmu/cache:/app/.cache logvar/danmu-api:latest
```

然后配 `DANMU_API_URL=http://127.0.0.1:9321`、`DANMU_API_TOKEN=your_token`。

<details>
<summary>danmu_api 参数建议</summary>

| 参数 | 建议 | 作用 |
|---|---|---|
| `TOKEN` | 自定义 | 与本站 `DANMU_API_TOKEN` 一致，否则静默拿不到弹幕 |
| `RATE_LIMIT_MAX_REQUESTS` | `0` | 关掉每 IP 限流（本站请求都来自同一 IP） |
| `SOURCE_ORDER` | `360` | 搜索源，别用带 `douban` 的默认值（最慢） |
| `PLATFORM_ORDER` | `qiyi,qq` | 优先爱奇艺、腾讯弹幕 |
| `OTHER_SERVER` | 另一个实例 | 自己抓空时转它 |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash 免费版 | serverless 部署必配 |
| `BILIBILI_COOKIE` | B站 `SESSDATA` | 只有 B站需要 |
| `VOD_REQUEST_TIMEOUT` | `6000` | 单源超时 |

部署在 CF Workers / Vercel 上的问题：出口 IP 共享易被限流；CF 免费版每请求最多 50 个子请求（长视频后半段没弹幕）；没有 Redis 时缓存会丢。自己的 VPS 没有这些问题。
</details>

---

## 功能说明

### 搜索与首页

**搜索**
- SSE 流式：各站边搜边出结果。
- 自动生成关键词变体，英文名转中文名。
- 同一部剧的各站线路合并成一张卡；同名不同作品拆成多张，标年份和集数。
- **片名索引**：有的采集站关了关键词搜索。服务器每天检查一次，把这些站的片名表爬到本地，搜索时先查本地再取详情。后台「片库」页看进度。
- **语音搜索**：录音交给 Whisper 转文字；没配 AI 时退回浏览器自带识别。
- **AI 找片**：用一段描述、台词或截图找片。AI 给出候选，再到 TMDB 核实（编造的片名会被筛掉）。

**首页**
- 板块可调顺序和开关；常用的分类筛选可以存成首页一行（自选分类）。
- **追剧日历**：服务器每 30 分钟拉各大站的更新，按天、按分类整理成一周的更新表；今天以后的日子显示「待播」：每 6 小时从 TMDB 同步排期（需要 TMDB_API_KEY），TMDB 没有的按前两周的更新规律预计。需要 SQLite。
- **杂志风**主题下，首页排成电子杂志（封面、专题、短评、播出表）。

### 短剧

**竖屏刷**（首页右上角「刷短剧」）
- 上下滑换部，一部看完自动下一集。
- 默认清屏；按住左右两侧 = 倍速（左右滑 1.5/2/3×，上滑锁定）。
- 进度条按住可拖。
- **长按中间 = 播放器页**：倍速、线路、选集、收藏、分享、完整播放都在这里。
- 点「完整播放」进详情页后，有「返回刷短剧」一键回来。

**「短剧」分类**（分类栏、分类大全、追剧日历都能进）
- 按题材浏览：都市、古装、甜宠、逆袭、重生穿越、悬疑、家庭。
- 按最新 / 热门排序，搜片名，可只看分集的。
- 点哪部就从哪部开始竖屏刷，往下接着刷这个列表。

**片库**
- 服务器每 30 分钟拉各站短剧分类的最新更新，并逐页往回补老片。
- 一集一个文件的进竖屏刷；整部拼成一个文件的只出现在分类页。
- 需要 SQLite（没有时存在内存里）。

### 线路分组与自动选源

**分组**（自动选源也按这个顺序偏好）

| 分组 | 含义 |
|---|---|
| 🟢 无广告 | 画面干净，插播会被去掉 |
| 🟡 有插播 | 画面干净，但插播去不掉（如没配 `CORS_PROXY_URL`） |
| 🟠 有水印 | 画面里烧录了广告，无法去除 |
| 🔴 可能无法播放 | 未评测的站，或只有服务器能连通 |

- **档案**：分级数据在 `lib/site-profiles/profiles.json`，按 API 域名匹配。
- **覆盖**：在 db.json 站点里写 `"ad_tier": "noburn"`（或 无广告 / 有插播 / 有水印），或 `"profile": { "tier", "res", "geo", "clip" }`。
- **时长对比**：同一集明显比别的线路长的，标「可能有广告」并排后。

**分辨率角标**
- 优先用这部片的实测宽高（主清单或播放中补测），本机记 30 天。
- 标「4K」但实际 1080P 的会如实标 1080P。
- 自动选源最多只选到 1080P（4K 码率高，弱网易卡），想看 4K 手动点。

**选源与测速**
- 先比可达性（直连 → 代理 → 只有服务器能通），同档内再比广告分组和速度。
- 测速结果本机缓存：测通 3 天、只有服务器能通 6 小时、不可用 12 小时。
- 播放失败自动换下一条；全部失败时有离线缓存就切缓存。

### 去广告

效果：**插播直接没有，进度条里也没有，没有「跳过广告」按钮。**

**① 边缘：Cloudflare Worker**（`cloudflare-cors-proxy.js`）

m3u8 经过 Worker 时按分段时长剔除广告：

1. **候选**：以 `#EXT-X-DISCONTINUITY` 分组，3–120 秒、少于 15 个分片的组。
2. **豁免**：只有一组的清单；镜头切分的正片碎片；定长切块打包。
3. **其它剔除**：不足 0.5 秒的追踪分片；外来域名且后缀可疑（`.vip/.bet/.top/.xyz` 等）的分片。
4. **保险丝**：要删的超过总时长 20%，或会删光内容，就整份放行。
5. **不过滤**：直播、多码率主清单、`?nofilter=1`。

**② 播放器：开播前剪掉插播**

有的站把广告切成和正片一样的分片藏在中间，或屏蔽 Worker。这类广告分辨率或时间戳和正片不同：

- 开播前读每段第一个分片的前 16KB 判断，把插播段从清单里删掉。
- 每集约 1–2 秒，结果本机缓存 30 天；看到最后 2 分钟时预扫下一集。
- 只扫档案标了 `clip` 的站，以及本机真遇到过插播的站。
- iOS / Safari：剪好的清单交服务器托管（`/api/hls/cut`，服务器不自己拉 m3u8）。
- 漏网的播到时静默跳过。
- 进度、历史、片头标记、分享时间都按原始时间轴存，换线路、换设备都对得上。

<details>
<summary>代理失败时的处理</summary>

不少 CDN 会封 Cloudflare 出口 IP。播放失败时经 Worker 再取一次 m3u8，按返回结果处理：

| 返回 | 判断 | 处理 |
|---|---|---|
| 5xx / 429 / 超时 | Worker 故障 | 换备用 Worker，都不行才本集直连 |
| 403 / 404 / 451，或不是 m3u8 | 源站封了 CF | 记 12 小时，能直连就直连，否则换线路 |
| 200 且有分片 | 偶发错误 | 直接重试 |
| 200 但 0 分片 | 过滤异常 | 依次试 `?nofilter=1`、直连、换线路 |
</details>

### 播放器

DPlayer + hls.js（打过补丁，修正 Chrome 长时间播放后声音变低沉）。

- **基础**：倍速 0.5–3×；进度记忆（30 天内、看过 1 分钟以上）；自动下一集并预热。
- **进度条缩略图**：拖动或悬停时显示画面预览。
- **画中画与投屏**：AirPlay、Chromecast（投的是去过广告的清单）、浏览器远程播放。
- **手机**：控制栏只留播放、下一集、设置、全屏；双击两侧 ±10 秒；全屏时左侧调亮度、右侧调音量。
- **桌面**：空格暂停/播放，及 DPlayer 自带快捷键。
- **起播看门狗**：14 秒没画面自动换线路。
- **屏幕常亮**：播放中不锁屏。

### 跳过片头片尾

奈飞式「跳过片头 / 跳过片尾」，不需要人工打点。

- **学习**：播放稳定后，后台拉本集和邻集的低码率音频，比对响度找出片头曲和片尾位置。
- **共享**：学到的位置上报服务器，全站共用。
- **确认**：两集学出来的值先只亮按钮；在第三集定位命中才算确认，确认后才自动跳。
- **开头贴片**：每集开头相同的许可证、平台 logo 单独识别为「跳过开头」。
- **片尾按钮**：有下一集叫「下一集」（立刻切），最后一集或循环时叫「跳过片尾」。片尾只亮按钮，不自动切。
- **流量**：每集约 10–20MB；省流量、2G、蜂窝网络下不分析；单剧上限 700MB，每次会话 2000MB。

### 离线缓存

- 播放页按集缓存到浏览器（IndexedDB），下载的是去过广告的版本。
- 断网时自动切到已缓存的集续播；没网打开时，用缓存合成离线选集列表。

### 弹幕

需配 [danmu_api](#弹幕服务-danmu_api)，未配置时自动隐藏。

**设置**
- 显示 / 海量、行数 1–20、速度 1–10、字号 12–44、6 种字体、不透明度 10–100%。
- 手动时间偏移；芒果弹幕按集自动校正。
- 开关和样式跨设备同步。

**匹配**：按「剧名 + 集名」匹配，宁可没有也不配错。
- 带上类型、年份、集数做提示：综艺不会配到同名电影，翻拍按年份区分，没写季号不会配到第二季。
- 认得写法差异：庆余年2 ↔ 庆余年第二季、未删减版、国语、大写数字等。
- 路演、花絮、纯享、解说、小剧场不当正片。
- 按日期命名的腾讯综艺（第20261010期）：按腾讯当天所有条目的时长和类别唯一对上才认。

**缓存**
- 服务器 SQLite 缓存，默认 7 天后后台更新，过期期间先回旧的。
- 同一集多人同时打开只回源一次；低置信结果只缓存 10 分钟，空结果不缓存。
- 单集最多 12000 条，超出按时间均匀采样。

### 评论与用户弹幕

需要 SQLite；`COMMENTS_DISABLE=1` 可关。

- **评论区**：详情页下方，可回复、点赞、举报。
- **用户弹幕**：播放器里发的弹幕会存下来，和平台弹幕合在一起，同一集换哪条线路都能看到。
- **谁能发**：只有独立用户（同步账号）能发；被封禁的发不了，发过的也不再展示。
- **作者身份**：显示为「观众XXXX」，不暴露令牌或邮箱。
- **审核**：
  1. 限速、每日上限、10 分钟内重复的不收。
  2. 屏蔽词（后台可改），不收网址和长串数字。
  3. AI 审核（配了 `CF_AI_*`）：广告、联系方式、色情、赌博、仇恨、隐私、违法直接拒收；拿不准的只给作者自己看，等站长决定。AI 出错或超时一律放行。
  4. 不同用户举报满 3 次自动收起，等站长处理。

### 收藏、片单与推送

**收藏（追剧）**
- 详情页标题旁的 ♥，每人最多 100 部。
- 有新集时显示「更新至第 N 集」并排到最前。
- 追更日历：卡片显示「周五更新」「通常每周三更新」，首页有「本周更新」条。
- 独立用户跨设备同步；主密码和没设密码的站只存本机。

**更新检查**
- 服务器每 10 分钟查一轮，只调用详情接口，**从不拉视频清单**。
- 按更新状态调整频率：刚更新 2 小时、连载中 4 小时、完结 72 小时。
- 全站最多跟踪 3000 部。需要 SQLite，`FAV_CHECK_DISABLE=1` 可关。

**片单**（像豆瓣豆列）
- 自建片子清单：名字、简介，随时加删。
- 可设公开，分享链接 `/?list=<id>`；设回私密后链接立即失效。
- 每人 50 个片单、每个 500 部。独立用户存账号，其他人存本机。

**推送通知**
- 收藏更新、求片有结果时推送，点开直接到那一集。
- 这台设备允许过通知就自动开；否则第一次点 ♥ 或求片后问一次。
- 需要 HTTPS；iPhone / iPad 要先「添加到主屏幕」（iOS 16.4+）。

**大家都在看**
- 按全站近 7 天实测观看统计。
- 除你之外至少 2 人各看过 2 分钟才上榜；你看过的不出现；只显示片名。

### 分享与 SEO

- **深链**：`/?play=剧名&ep=集名&t=秒数`（同名多部带 `&w=`），可分享到微信、QQ、Telegram 等。
- **截帧分享**：当前画面 + 剧名、集数、时间 + 二维码，扫码从这一秒开始看。
- **未登录试看**：打开分享链接直接从分享的位置播放，试看 `SHARE_TRIAL_MINUTES` 分钟，到时登录后接着播。
- **未登录预览**：不能试看时只显示标题、简介、海报（**不访问任何资源站**）。
- **社媒卡片**：爬虫抓取时返回 OpenGraph / Twitter Card。
- **SEO**：`/movie/:id`、`/tv/:id` 服务端渲染页，`/sitemap.xml`、`/robots.txt`。

### 直播 (IPTV)

聚合 [vbskycn/iptv](https://github.com/vbskycn/iptv) 和 [iptv-org](https://github.com/iptv-org/iptv)，约 1800 个频道。

- **筛选**：13 种语言 × 22 个种类，每页 48 个。
- **线路**：每个频道多条线路，失败自动切换；最近观看跨设备同步；可分享 `?live=频道名`。
- **必须配 `CORS_PROXY_URL`**：http 源经 Worker 升级为 https。
- **可达性**：服务器测每个频道的前 2 条线路，不通的置灰。央视多为运营商内网地址，海外大多看不了，可用 `LIVE_M3U_EXTRA` 接付费源。
- **成人频道**：`LIVE_M3U_ADULT` 注入（不内置），默认被成人过滤隐藏。

### 账号与同步

**用户类型**

| 类型 | 来源 | 同步 |
|---|---|---|
| 主密码 | `ACCESS_PASSWORD` 第 1 个 | 不同步，多人共用 |
| 独立用户 | `ACCESS_PASSWORD` 其余每个 | 跨设备同步 |

- **同步内容**：观看历史（增量，只推变化的）、收藏、片单、弹幕设置、主题、封面大小、最近频道。需要 SQLite。
- **扫码登录**：电视、盒子、App 登录页显示二维码，用已登录的手机扫码确认即可。二维码 5 分钟过期、只能用一次。
- **求片**：配了 `ADMIN_TOKEN` 才有。每人最多 3 条待处理；站长回复链接或标记「需补充 / 无法提供」，用户在「我的求片」查看。
- **封禁**：被封用户整站锁屏，同步、求片、评论一律拒绝。
- 注意：密码只拦页面，搜索等接口本身不校验密码。

### 站长后台

打开 `/admin`，输入 `ADMIN_TOKEN` 登录（需要 SQLite）。

| 页面 | 内容 |
|---|---|
| 概览 | 用户数、活跃、观看时长、每日柱状图、热门剧、分享来源、待处理求片 |
| 用户 | 筛选、排序、搜索；每人看过的剧和逐集明细；封禁 / 解封 |
| 求片 | 按状态分栏、「N 人想看」排序、回复模板、批量处理 |
| 分享 | 每条分享的渠道、打开次数、来源 App、带来的登录 |
| 评论 | 被扣下的评论和弹幕、屏蔽词、AI 审核记录 |
| 片库 | 片名索引进度 |
| AI 模型 | 模型目录、测评评级、为各功能选模型（配了 `CF_AI_*` 才有） |

**观看时长是实测的**
- 只在画面真在走、页面在前台时计时，4 小时无操作视为挂机。
- 断网先存本机，恢复后补发；每人每天最多计 24 小时。
- 「看过一集」= 实际看 2 分钟以上，或看到 90%。

**分享来源**：每次分享生成短码（`&s=`），按打开者的 User-Agent 识别来自哪个 App，不存 IP。

不想统计设 `STATS_DISABLE=1`。

### 外观、TV 模式与偏好设置

**主题**：风格 × 明暗两个设置，明暗可跟随系统，跨设备同步。

| 风格 | 特点 |
|---|---|
| 默认 | 原来的影院风格 |
| 极简黑白 | 只有黑白、直角、无阴影 |
| 赛博霓虹 | 品红与青色霓虹、发光描边 |
| 复古胶片 | 琥珀色、衬线标题、老相片海报 |
| 杂志风 | 首页排成电子杂志 |

**TV 模式**
- 开启：偏好设置里打开，或访问 `?tv=1`（`?tv=0` 关闭，会记住）。
- 电视设备（Android TV、Fire TV、Tizen、WebOS 等）和 Android App 自动开启。
- 方向键导航、确认键选择、返回键退出；播放时有倍速、换线路、±10 秒、选集按钮。
- 老内核 WebView 给出提示而不是白屏。

**偏好设置**（右下角 ⚙️）

| 选项 | 默认 | 说明 |
|---|---|---|
| 隐藏随机盲盒 | 关 | 首页不显示随机推荐 |
| 过滤成人内容 | 开 | 盲盒只出 PG-13 / TV-14 及以下，隐藏成人直播 |
| 跳过按钮 | 开 | 片头片尾处显示跳过按钮 |
| 自动跳过片头/片尾 | 关 | 已确认的片头直接跳；片尾仍只亮按钮 |
| 封面/文字大小 | 标准 | 小 / 标准 / 大 / 特大，跨设备同步 |

---

## Android App

Capacitor 外壳，打开内置的站点地址（默认 `https://ednovas.video`）。App ID `com.ednovas.donguatv`，最低 Android 7.0。

- **自动构建**：推送 `v*.*.*` tag 触发 GitHub Actions，在 Releases 下载 APK。
- **自定义构建**：Actions → Android Build & Release → Run workflow，填服务器地址、App 名称、版本号。
- **签名**：配了 Secrets（`SIGNING_KEY`、`KEY_STORE_PASSWORD`、`ALIAS`、`KEY_PASSWORD`）就用它，否则 debug 签名。
- **图标**：由 `public/icon.png` 自动生成。

<details>
<summary>本地构建</summary>

需要 Node 22+、JDK 21、Android SDK 36。

- 服务器地址：`capacitor.config.json` 的 `server.url`
- App 名称：`android/app/src/main/res/values/strings.xml`
- 版本：`android/app/build.gradle`

```bash
npm install && npx cap sync android
cd android && ./gradlew assembleRelease   # 产物未签名，需自行签名
```
</details>

App 有问题时，网页版和 PWA 兼容性最好；电视推荐当贝浏览器。

---

## 数据与备份

| 文件 | 内容 | 能删吗 |
|---|---|---|
| `db.json` | 采集源配置 | 否 |
| `cache.db`（+ `-wal` / `-shm`） | **所有用户数据**：历史、设置、收藏、片单、评论、推送、求片、统计、片头标记；以及各类缓存 | **否** |
| `shorts-sites.json` | 只给短剧用的站（可选） | 否 |
| `title-index.db`（+ `-wal` / `-shm`） | 片名索引 | 可以，会自动重爬 |
| `public/cache/images/` | TMDB 图片缓存（上限 1GB） | 可以 |
| `cache_*.json` | 仅 `CACHE_TYPE=json` 时的缓存与片头标记 | 可以，但会丢片头标记 |

> ⚠️ `cache.db` 不只是缓存，删掉会丢掉所有用户数据。换服务器时整个带走。

在线备份（不用停服务）：

```bash
sqlite3 /opt/dongguaTV/cache.db ".backup '/root/backup/cache-$(date +%F).db'"
cp /opt/dongguaTV/db.json /root/backup/
```

---

## 开发与测试

**结构**
- 前端：单文件 `public/index.html`（Vue 3）
- 后端：`server.js`（VPS）/ `api/index.js`（Vercel）
- 模块：`lib/`（番剧源、剪后清单、线路档案、弹幕缓存、统计、收藏、推送、片单、评论、短剧、追剧日历、片名索引、AI）

**回归测试**（`node scripts/<名字>.mjs`）

| 方面 | 脚本 |
|---|---|
| 去广告 | `worker-test`、`adclip-test`、`hls-cut-test` |
| 线路与搜索 | `source-list-test`、`site-profiles-test`、`src-len-test`、`title-index-test`、`kazumi-test` |
| 播放器 | `hole-skip-test`、`seek-preview-test`、`watch-meter-test`、`check-hls-lc-patch`（升级 hls.js 必跑） |
| 片头片尾 | `intro-refine-test`、`intro-mark-migrate-test` |
| 弹幕 | `danmaku-match-test`、`danmaku-cache-test`、`danmaku-sync-test`、`danmaku-offset-test`、`danmaku-auto-test`、`danmaku-load-test`、`danmaku-flash-test` |
| 账号与同步 | `history-sync-test`、`qr-login-test`、`share-trial-test`、`user-stats-test` |
| 收藏与推送 | `favorites-test`、`favorites-client-test`、`push-test`、`frame-share-test` |
| 新功能 | `shorts-feed-test`、`playlists-test`、`comments-test`、`calendar-test`、`catalog-test`、`voice-test`、`ai-models-test` |
| 页面结构 | `page-syntax-test`、`index-methods-test`、`home-layout-test`、`resume-layout-test` |

**改动须知**
- 改了前端库：`public/sw.js` 里同时升 `?v=` 和 `CACHE_VERSION`。
- 改了 Worker：要重新部署 Worker。
- 改了 `index.html`：服务器会缓存它，要重启。

---

## 致谢

由 **kk爱吃王哥呆阿龟头** 设计编写，**ednovas** 优化功能与部署。

- 弹幕：[danmu_api](https://github.com/huangxd-/danmu_api)
- 番剧规则：[KazumiRules](https://github.com/Predidit/KazumiRules)（MIT，见 `lib/kazumi/rules/NOTICE`）
- 数据：**TMDb** 与各 **Maccms** 接口

## 免责声明

1. 本项目仅作为 Node.js 与 Vue 3 的学习项目开源。
2. 本项目不内置任何影视资源接口，文档与代码中的地址均为占位示例。
3. 使用者需自行寻找合法接口并遵守当地法律法规。
4. 开发者不存储、不发布、不参与任何视频内容的制作与传播。
