# E视界 (DongguaTV Enhanced Edition)

现代流媒体聚合播放器：用 TMDb 做影视资料、聚合多个 Maccms 采集站做播放源，基于 Node.js + Express + Vue 3。原版项目：[Minerchu/dongguaTV](https://github.com/Minerchu/dongguaTV)

在原版基础上重构了前后端，并加入了：流式搜索、按广告情况分组的线路与自动选源、边缘 + 播放器两级去广告、跳过片头片尾、弹幕、直播、离线缓存、多用户云同步、站长后台、分享深链、PWA / Android / TV 模式等。

**演示**：https://ednovas-test.vercel.app （不含任何数据）

<img width="2547" height="1226" alt="image" src="https://github.com/user-attachments/assets/15392a90-9078-45b6-828d-829402669950" />

<img width="2547" height="1227" alt="image" src="https://github.com/user-attachments/assets/d03543f5-34a4-414b-a131-62eda0af21b2" />

<img width="2547" height="1229" alt="image" src="https://github.com/user-attachments/assets/e8bd4e14-dbd2-4d49-a1fc-7979c1ca22a4" />

---

## 目录

- [功能一览](#功能一览)
- [快速开始](#快速开始)：[准备](#1-准备) · [部署](#2-部署) · [环境变量](#3-环境变量)
- [可选组件](#可选组件)：[CORS 代理](#cors-代理去广告依赖它) · [TMDB 反代](#tmdb-反代大陆用户) · [弹幕服务](#弹幕服务-danmu_api)
- [功能说明](#功能说明)：[线路与测速](#线路分组与自动选源) · [去广告](#去广告) · [播放器](#播放器) · [跳过片头片尾](#跳过片头片尾) · [弹幕](#弹幕) · [直播](#直播-iptv) · [离线缓存](#离线缓存) · [账号与同步](#账号同步与求片) · [站长后台](#站长后台) · [分享与 SEO](#分享深链与-seo) · [TV 模式与偏好设置](#tv-模式与偏好设置)
- [Android App](#android-app)
- [数据与备份](#数据与备份)
- [开发与测试](#开发与测试)
- [致谢与免责声明](#致谢)

---

## 功能一览

| 方面 | 说明 |
|---|---|
| **找片** | TMDb 海报/背景/评分/简介 + 多个 Maccms 采集站聚合；SSE 流式搜索（边搜边显示）；自动生成关键词变体、英文名自动转中文名；同名不同作品自动拆成多张卡片并标年份/集数；内置 4 个番剧规则源 |
| **首页** | 本周趋势轮播、20 个榜单（含随机盲盒）、继续观看、为你推荐、分类快捷入口、直播频道 |
| **线路** | 按"看的时候有没有广告"分组（无广告 / 有插播 / 有水印 / 可能无法播放）+ 分辨率角标；本机测速 + 服务器兜底测速，结果按站缓存；播放失败自动换线路 |
| **去广告** | Cloudflare Worker 边缘剔除广告分段；Worker 删不掉的插播，由播放器在播放前把整段从清单里剪掉（进度条里都没有） |
| **播放** | 倍速 0.5–3x、进度记忆、自动下一集并预热、画中画、投屏（AirPlay / Chromecast）、手势、跳过片头片尾（自动学习、全站共享）、弹幕 |
| **直播** | 约 1800 个频道、13 种语言 × 22 个种类筛选、最近观看、多线路自动切换 |
| **离线** | 按集离线缓存到本机；断网时自动用缓存续播 |
| **账号** | 访问密码（多密码 = 多用户）、观看历史与设置跨设备同步、求片、封禁 |
| **站长后台** | `/admin`：实测观看时长、每人看了什么、分享从哪个 App 打开、求片处理 |
| **分享** | `?play=剧名&ep=集名&t=秒` 深链、各社交平台分享、未登录预览框、社媒卡片、SEO 页面与 sitemap |
| **多端** | PWA（正常刷新即更新）、Android App、TV 模式（遥控器导航） |

> 部分功能依赖服务器能力，**Vercel 无状态部署不支持**：见 [Vercel 的限制](#vercel)。

---

## 快速开始

### 1. 准备

**TMDb API Key（必需）**：注册 [TMDb](https://www.themoviedb.org/signup) → [API 设置](https://www.themoviedb.org/settings/api) 申请（类型选 Developer）→ 复制 **API Key (v3 auth)**。

**采集源（必需）**：本项目**不内置**任何资源接口，需自行准备合法的 Maccms V10 JSON 接口，写进 `db.json`（首次运行会由 `db.template.json` 生成一份占位）：

```json
{
  "sites": [
    { "key": "site1", "name": "站点名称", "api": "https://example.com/api.php/provide/vod/" }
  ]
}
```

- 站点只能靠删除来停用（`active` 字段不生效）。
- 可选字段 `ad_tier` / `profile` 用来覆盖线路分组，见[线路分组](#线路分组与自动选源)。
- 也可以用 `REMOTE_DB_URL` 远程加载（5 分钟缓存，失败回退本地）；Vercel 上用 `SITES_JSON`。

### 2. 部署

需要 **Node.js 20 或更新**（推荐 22；`better-sqlite3` 已不支持 18）。要用多用户同步、求片、站长后台、观看统计，请设 **`CACHE_TYPE=sqlite`**。

#### Docker（推荐）

镜像：`ednovas/dongguatv:latest`（Docker Hub）或 `ghcr.io/ednovas/dongguatv:latest`，支持 amd64 / arm64 / armv7。

```bash
# 先建好文件，否则 Docker 会把它们当成目录挂载(报 EISDIR)
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

本地构建：`docker build -t donggua-tv .`。注意 `.dockerignore` 目前不排除 `db.json`、`cache.db`，构建前请移走它们，免得把用户数据打进镜像。
</details>

> SQLite 用 WAL 模式，最近的写入可能还在旁边的 `cache.db-wal` 里；上面只挂载了 `cache.db` 本身，**重建容器前请先 `docker stop`**，备份方法见[数据与备份](#数据与备份)。

#### 一键脚本 / 手动 / PM2

```bash
curl -fsSL https://raw.githubusercontent.com/ednovas/dongguaTV/main/install.sh | bash
```

脚本会询问 TMDb Key、TMDB 反代、端口、缓存类型、访问密码、安装目录，并用 PM2 启动（进程名 `donggua-tv`）。CORS 代理、弹幕、站长令牌等需要之后在 `.env` 里补。

手动安装：

```bash
git clone https://github.com/ednovas/dongguaTV.git && cd dongguaTV
npm install                          # 没有预编译包时需要 build-essential python3 编译 better-sqlite3
cp .env.example .env && nano .env    # 至少填 TMDB_API_KEY
node server.js                       # 或 pm2 start server.js --name donggua-tv && pm2 save && pm2 startup
```

宝塔面板：软件商店装 Node.js 版本管理器（20+）→ 网站 → Node 项目 → 添加，启动文件 `server.js`、端口 `3000` → 配好 `.env` 后重启。

#### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV&env=TMDB_API_KEY,SITES_JSON,REMOTE_DB_URL,ACCESS_PASSWORD,TMDB_PROXY_URL&envDescription=TMDB_API_KEY%20is%20required.%20Use%20SITES_JSON%20(Base64)%20or%20REMOTE_DB_URL%20for%20site%20config.&envLink=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV%23vercel)

在 Settings → Environment Variables 填 `TMDB_API_KEY`，以及 `SITES_JSON`（JSON 或 Base64 的 db.json 内容，推荐）或 `REMOTE_DB_URL`。改完变量要 **Redeploy**。

<a id="vercel"></a>**Vercel 的限制**（Serverless 无状态，只跑 `api/index.js`）：

- **数据与同步**：没有 SQLite，所以没有历史/设置同步、求片、站长后台和观看统计。
- **广告过滤**：`CORS_PROXY_URL` 不生效，没有边缘去广告。iOS/Safari 上"播放前剪插播"也退化为播放中跳过。
- **页面与功能**：没有直播、跳过片头的共享标记、分享卡片、`/movie` 与 `/tv` SEO 页、sitemap。
- **搜索**：没有关键词变体、英文转中文和搜索缓存。

想要完整功能请用 VPS / Docker。

### 3. 环境变量

只有 `TMDB_API_KEY` 必填。

**基础**

| 变量 | 默认 | 说明 |
|---|---|---|
| `TMDB_API_KEY` | — | **必填**。TMDb v3 Key |
| `PORT` | `3000` | 监听端口 |
| `CACHE_TYPE` | `json` | `sqlite`（推荐，同步/求片/后台/统计都要它）/ `json` / `memory` / `none`。SQLite 起不来时会自动退回 `memory` |
| `ACCESS_PASSWORD` | — | 访问密码。逗号分隔多个 = 多用户：**第 1 个是共用的"主密码"（不同步）**，其余每个是一个独立用户（历史/设置跨设备同步）。登录可选"记住 1 年" |
| `ADMIN_TOKEN` | — | 站长令牌：开启 `/admin` 站长后台与**求片**功能（不设则两者都关闭） |
| `SITE_URL` | 按请求 Host 推断 | 分享卡片、SEO、sitemap 用的站点地址 |

**采集源与网络**

| 变量 | 默认 | 说明 |
|---|---|---|
| `REMOTE_DB_URL` | — | 远程 db.json（5 分钟缓存，失败回退本地） |
| `SITES_JSON` | — | 仅 Vercel：直接填 JSON 或 Base64 的站点配置，优先于 `REMOTE_DB_URL` |
| `CORS_PROXY_URL` | — | Cloudflare Worker CORS 代理，**边缘去广告与直播都靠它**。可逗号分隔多个，第一个是主代理，故障时前端自动换备用 |
| `TMDB_PROXY_URL` | — | TMDB 反代。图片与搜索翻译设了就用；`/api/tmdb-proxy` 按访客 IP 判断大陆才走 |
| `SERVER_IN_CHINA` | — | 设 `true`：服务器自己发起的 TMDB 请求（分享卡片、预览、SEO 页、sitemap）强制走反代 |

**弹幕**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DANMU_API_URL` | — | 自建 `danmu_api` 地址，设了才有弹幕；逗号分隔多个实例并行赛跑 |
| `DANMU_API_TOKEN` | — | 对应令牌；逗号分隔按顺序与实例配对，只填一个则共用 |
| `DANMAKU_CACHE_DAYS` | `7` | 服务器缓存一集弹幕多少天后再回源更新（过期先回旧的、后台更新） |
| `DANMU_API_SINGLE_INSTANCE` | — | `1` = 声明 danmu_api 只有一个实例（自己 VPS 上的 Docker）。这时没有视频地址的集（合并源、番组计划等）也可以按 ID 取；多实例（CF Workers 等）别开，会串到别的剧 |

**直播**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVE_TV_DISABLED` | — | `1` = 关闭直播 |
| `LIVE_M3U_URL` / `LIVE_M3U_FALLBACK` | vbskycn 源 / 其镜像 | 主源与备源 |
| `LIVE_M3U_IPTVORG` / `LIVE_M3U_ZHO` | iptv-org `cn.m3u` / `zho.m3u` | 中文 / 华语补充源（`zho` 多为海外 CDN，海外可达性更好） |
| `LIVE_M3U_EXTRA` | — | 自定义 M3U（逗号分隔），如付费 IPTV |
| `LIVE_M3U_DISABLE` | — | `1` = 关闭所有内置源，只留 `EXTRA` / `ADULT` |
| `LIVE_M3U_ADULT` | — | 成人直播源（逗号分隔，仓库不内置），受前端成人过滤开关控制 |
| `LIVE_NO_VALIDATE` | — | `1` = 跳过服务器对频道的可达性测试 |

**功能开关**

| 变量 | 默认 | 说明 |
|---|---|---|
| `KAZUMI_DISABLE` | — | `1` = 关闭内置番剧规则源 |
| `KAZUMI_SITES` | 全部 | 只启用指定番剧源：`7sefun,dm84,moonci,xfdm` |
| `HLS_CUT_DISABLE` | — | `1` = 关闭服务器托管剪后清单（iOS/Safari 播放前剪插播要它） |
| `STATS_DISABLE` | — | `1` = 关闭观看时长与分享统计（站长后台里就只有基础信息） |

> 布尔开关认 `1/true/yes/on`，填 `0/false` 等于没开。

---

## 可选组件

### CORS 代理（去广告依赖它）

浏览器直连资源站失败或太慢时，经代理中转；**边缘去广告、直播播放、服务器测速都依赖它**。推荐 Cloudflare Worker：

1. Cloudflare → Workers & Pages → Create Worker，粘贴 `cloudflare-cors-proxy.js` → Deploy；
2. `.env` 里配 `CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev`（可再部署一个做备用，逗号分隔）。

- **额度**：免费版每天 10 万次请求，自用足够。
- **更新**：改了 `cloudflare-cors-proxy.js` 要回 Dashboard 重新粘贴部署，网站更新不会带上 Worker。
- **只有 Worker 版才会**：
  - 去广告；
  - 遇到 401/403/404/451 时去掉 Referer 重试；
  - 让视频分片直连 CDN、不经代理二次中转。

`proxy-server.js` 是一个最简 Node 中转（`PORT=8080 node proxy-server.js`，只用 Node 内置模块）。它**只做 CORS 转发，不去广告、所有分片都经它转发**，而且生成的地址是 `http://`，在 HTTPS 站点上会被浏览器拦截，需要前面再套 HTTPS。它的 `PROXY_PASSWORD` 目前前端不会发送，设了会导致所有代理请求 403。

### TMDB 反代（大陆用户）

TMDB 在大陆访问不了：Cloudflare 新建 Worker，粘贴 `cloudflare-tmdb-proxy.js` 部署，`.env` 配 `TMDB_PROXY_URL=https://tmdb-proxy.your-name.workers.dev`（服务器在大陆再加 `SERVER_IN_CHINA=true`）。

### 弹幕服务 danmu_api

弹幕来自自建的 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api)（兼容弹弹play，聚合爱奇艺/腾讯/优酷/B站/芒果/360 等）。推荐在自己的 VPS 上用 Docker 跑：

```bash
docker run -d --name danmu-api --restart unless-stopped -p 127.0.0.1:9321:9321 \
  -e TOKEN=your_token -e RATE_LIMIT_MAX_REQUESTS=0 \
  -e SOURCE_ORDER=360 -e PLATFORM_ORDER=qiyi,qq \
  -v /opt/danmu/cache:/app/.cache logvar/danmu-api:latest
```

然后配 `DANMU_API_URL=http://127.0.0.1:9321`、`DANMU_API_TOKEN=your_token`。

<details>
<summary>danmu_api 参数建议与部署选择</summary>

| 参数（danmu_api 自己的） | 建议 | 作用 |
|---|---|---|
| `TOKEN` | 自定义 | 与本站 `DANMU_API_TOKEN` 一致（不一致会静默拿不到弹幕） |
| `RATE_LIMIT_MAX_REQUESTS` | `0` | 关掉每 IP 限流——本站所有请求都来自同一个服务器 IP |
| `SOURCE_ORDER` | `360` | 搜索源；别用默认带 `douban` 的（最慢） |
| `PLATFORM_ORDER` | `qiyi,qq` | 优先取爱奇艺/腾讯弹幕 |
| `OTHER_SERVER` | 另一个可用实例 | 自家抓空时转它 |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash 免费版 | serverless 部署必配，否则频繁 `comment not found` |
| `BILIBILI_COOKIE` | B站 `SESSDATA` | 只有 B站 这一路需要 |
| `VOD_REQUEST_TIMEOUT` | `6000` | 单源超时 |

部署在 CF Workers / Vercel 等 serverless 上的问题：出口 IP 共享容易被平台限流；CF 免费版每请求最多 50 个子请求（长视频后半段没弹幕）；没有 Redis 时缓存跨请求丢失。自己的 VPS 跑 Docker 没有这些问题。
</details>

---

## 功能说明

### 线路分组与自动选源

线路按"看的时候有没有广告"分四组显示，自动选源也按这个顺序偏好：

| 分组 | 含义 | 何时归入 |
|---|---|---|
| 🟢 无广告 | 画面干净，插播的视频广告会被去除 | 档案为 `clean`，或 `noburn` 且去广告真在链路里（见下） |
| 🟡 有插播 | 画面干净，但插播广告去不掉 | `noburn` 但去广告不可用（如没配 `CORS_PROXY_URL`、关了广告过滤），或 db.json 指定 |
| 🟠 有水印 | 画面里烧录了广告，无法去除 | 档案为 `ads`；界面只提示"请不要相信视频中的任何广告内容" |
| 🔴 可能无法播放 | 排在最后，仅供尝试 | 未评测的站（不在档案里的自定义站都在这），或本机测速只有服务器能通（多为海外受限） |

- **档案**：分级数据在 `lib/site-profiles/profiles.json`，按 API 域名匹配。另有分辨率角标（4K / 1080P / 720P / 标清）、海外受限、H.265 标记（本机不能解 H.265 时不自动选）。
- **覆盖档案**：在 `db.json` 的站点里写 `"ad_tier": "noburn"`（认 `clean`/`noburn`/`insert`/`unknown`/`ads` 或 无广告/有插播/有水印 等中文名），或写 `"profile": { "tier": ..., "res": "1080p", "geo": 1, "clip": 1 }` 逐项覆盖。
- **自动选源**：先比可达性（本机直连 → 代理 → 只有服务器能通），同一可达档内才按广告分组和速度挑。
- **测速缓存**：结果按站点存在本机：测通 3 天、只有服务器能通 6 小时、不可用 12 小时，回访直接套用；「刷新线路」强制重测。
- **播放失败**：自动换到下一条（优先有当前这一集的线路）；全部失败时如有离线缓存则切到缓存。
- **卡片合并**：同一部剧的各站线路合并到一张卡片。同一个站只保留一条；首集地址相同的多个站（同一片源换了 API 名）也只留一条。同名但不是同一部的作品（如同名动画与电影）拆成多张卡片并标年份/集数。

### 去广告

两级配合，用户看到的效果是：**插播广告直接没有，进度条里也没有，没有任何"跳过广告"按钮**。

**① 边缘（Cloudflare Worker，`cloudflare-cors-proxy.js` v2.4）**：m3u8 经 Worker 时按分段时长剔除广告，规则按顺序：

1. **候选**：以 `#EXT-X-DISCONTINUITY` 切分成组，3–120 秒且少于 15 个分片的组是候选广告。
2. **豁免**：
   - 只有一组的清单不处理；
   - 镜头切分的正片碎片，以及"每 N 片切一块"的定长打包，都不删。
3. **其它剔除**：
   - 不足 0.5 秒的非 ts 追踪分片；
   - 与正片不同注册域名、且挂在 `.vip/.bet/.top/.xyz` 等可疑后缀下的分片。
4. **保险丝**：要删掉的超过总时长 20%，或删完一个内容组都不剩，就整份放行。任何情况下都不会输出 0 分片清单。
5. **其它**：
   - 删过东西时顺带清理 `#EXT-X-CUE` / `DATERANGE` / `SCTE35`；
   - 直播与多码率主清单不过滤；
   - `?nofilter=1` 只做转发不过滤。

**② 播放器（播放前剪掉插播）**：有的站（如意、电影天堂）把 15–20 秒的广告切成和正片一样的分片藏在中间，或干脆屏蔽 Worker，边缘删不掉。但这类广告在解码层和正片不同（分辨率不同，或首帧时间戳重新开始）。

- **怎么剪**：播放器在拿到清单后、开播前，读每段第一个分片的前 16KB 判断，然后把插播段从清单里删掉。每集约 120 个小请求、1–2 秒，结果按清单指纹在本机缓存 30 天。看到本集最后 2 分钟时会预扫下一集。
- **只扫需要的站**：档案标了 `clip` 的站，以及本机播放中真跳到过插播的站（自动记住 30 天）。CDN 拒绝探测（403/429）时立即停手。
- **iOS / Safari**：原生 HLS 只认地址，剪好的清单交给服务器托管（`/api/hls/cut`，服务器只存客户端交上来的文本、自己不拉 m3u8）。
- **兜底**：没剪到的，播到时直接静默跳过去，片尾的直接进下一集。
- **时间轴**：进度、历史、片头标记、分享时间、投屏都按原始时间轴存取，换线路/设备都对得上。
- **范围**：跟随播放器设置里的「广告过滤」开关。直播、多码率主清单、加密/fMP4 清单、番剧 MP4 线路、离线副本不处理。

<details>
<summary>代理失败时的分诊（能播优先，过滤尽力，不误伤好站）</summary>

不少源站 CDN 会封 Cloudflare 出口 IP（直连正常、经 Worker 必 403）。播放失败时客户端经 Worker 再取一次本集 m3u8，按真实返回分类：

- **Worker 5xx / 429 / 超时**：Worker 自身故障。先试备用 Worker，都不行才本集直连，不记账、下次照常走过滤。
- **403 / 404 / 451，或 200 但不是 m3u8**：源站封了 CF。记 12 小时；能直连就直连（提示可能有广告），否则换线路。
- **200 且有分片**：只是偶发错误，直接重试过滤代理。
</details>

### 播放器

DPlayer + hls.js（打过补丁，修正 Chrome 长时间播放后声音变低沉的问题）。

- **倍速与进度**：倍速 0.5–3x，记住选择；进度记忆在 30 天内、看过 1 分钟以上时恢复；播完自动下一集，最后 2 分钟预热下一集。
- **画中画与投屏**：画中画；投屏依次尝试 AirPlay、Chromecast（投的是剪过广告的清单）、浏览器远程播放，都不行时给出指引并复制直链。
- **屏幕常亮**：播放中保持屏幕常亮。
- **手机**：控制栏只留播放 / 下一集 / 设置 / 全屏，其余在齿轮菜单里；双击左右侧快退/快进 10 秒；全屏时左侧滑动调亮度、右侧调音量。
- **桌面**：空格键暂停/播放，另有 DPlayer 自带快捷键。
- **起播看门狗**：14 秒内没有任何画面就自动换线路。

### 跳过片头片尾

奈飞式「跳过片头 / 跳过片尾」，不用人工打点。

- **怎么学**：播放稳定后，后台拉本集和邻集的 m3u8（有多码率时选最低码率），解出音频算 10Hz 响度包络，再做互相关找出片头曲和片尾的位置。iOS 也能用，AES-128 加密源会自动解密。解不了的源就在播放时边看边学。
- **全站共享**：学到的时间按（剧名、线路、集号、时间轴通道）上报服务器，多人 ±5 秒加权投票。**自动跳过只信被佐证过的标记**（至少 2 票或本机实测）。学习成果（几 KB 的包络）也备份到服务器，换线路只需定位、不用重学。
- **开头贴片**：每集开头相同的许可证、平台 logo 会单独识别成「跳过开头」。
- **设置**：偏好设置里「跳过按钮」（默认开）、「自动跳过片头/片尾」（默认关，开了直接跳，片尾直接下一集）。
- **流量**：低码率源每集约 10–20MB；省流量模式、2G 和蜂窝网络下不分析；单剧上限 700MB、每次会话 2000MB。

### 弹幕

需配 [danmu_api](#弹幕服务-danmu_api)，未配置时自动隐藏、不报错。

- **前端**：控制栏有独立的弹幕设置（手机在齿轮 → 弹幕样式），可调显示/海量、行数 1–20、速度 1–10 级、字号 12–44、6 种字体、不透明度 10–100%。开关和样式跨设备同步（海量开关只存本机）。
- **服务器匹配**：按"剧名 + 集名"去 danmu_api 匹配，宁可没弹幕也不错配。
  - **前端提示**：播放页会带上这部剧的类型（由资源站分类归一）、年份、集数作为提示，从「继续观看」打开时也一样。
  - **防撞名**：综艺不会拿到同名电影的弹幕，不同年份的翻拍按年份区分，没写季号的不会配到第二季。
  - **识别写法差异**：季号写法不同（庆余年2 ↔ 庆余年第二季）、版本标签（未删减版、国语）、标点和大写数字都能认出来。
  - **衍生内容**：路演、花絮、纯享、解说、小剧场这类不当作正片。
  - **回归测试**：规则用约 200 个真实用例回放测试（`scripts/danmaku-match-test.mjs`）。
- **按视频地址取弹幕**：danmu_api 的集 ID 只在单个实例的内存里有效，多实例部署（如 CF Workers）时按 ID 取会串到别的剧。现在按视频地址取；按地址取遇到限流/超时就跳过这一次，不退回按 ID。只有 danmu_api 是不支持按地址取的老版本时才按 ID 取，且这类结果不缓存（建议升级 danmu_api）。
- **多实例**：并行赛跑，名字贴合的结果优先。
- **服务器缓存**：贴合度高的结果在服务器上 SQLite 持久缓存（压缩存储，默认 7 天后后台更新，过期期间先回旧的）。同一集多人同时打开只回源一次，重启不丢。名字只是沾边的低置信结果只缓存 10 分钟，空结果不缓存。单集最多 12000 条，超出按时间均匀采样。
- **切换内容**：切到直播或别的剧时，上一部的弹幕会被整份丢弃，晚到的旧弹幕响应也会被丢弃。

### 直播 (IPTV)

聚合公开 M3U（[vbskycn/iptv](https://github.com/vbskycn/iptv) + [iptv-org](https://github.com/iptv-org/iptv)），约 1800 个频道。

- **筛选**：中文 + 12 种外语（共 13 种语言）、22 个种类，按「语言 × 种类」两级筛选。每页 48 个，只渲染当前页。
- **最近观看与线路**：最近观看最多 12 个频道，跨设备同步；每个频道有多条线路，失败自动换下一条；可分享 `?live=频道名`。
- **可达性**：
  - 直播多为 http 运营商源，**必须配 `CORS_PROXY_URL`**：https 源浏览器直连，http 源经 Worker 升级。
  - 服务器在后台测每个频道的前 2 条线路，通的排前，不通的置灰（未配代理时不测）。
  - CCTV 等央视频道多为运营商内网地址，海外大多放不了；想稳定看可以用 `LIVE_M3U_EXTRA` 接付费 IPTV。
- **成人频道**：用 `LIVE_M3U_ADULT` 注入（本仓库不内置），归「成人」类，默认被成人过滤开关隐藏。

### 离线缓存

- **缓存**：播放页可按集离线缓存（存在浏览器 IndexedDB，经去广告代理下载，下载的就是去过广告的版本），可看进度、取消、删除、查看占用。
- **断网时**：自动切到已缓存的集续播；没网打开时，用已缓存的集合成一个离线选集列表。

### 账号、同步与求片

- **访问密码**：`ACCESS_PASSWORD` 逗号分隔多个时，第 1 个是多人共用的主密码（不同步），其余每个是一个独立用户。注意：目前密码只拦截页面，搜索等接口本身不校验密码。
- **同步**：独立用户的观看历史（含删除记录，跨设备不会被同步回来）、弹幕开关/样式、封面大小、最近频道跨设备同步。需 `CACHE_TYPE=sqlite`。历史是增量同步：只推送有变化的那几部，每部只带上次用的线路的选集，播放中每次推送几 KB。
- **求片**：配了 `ADMIN_TOKEN` 才出现。登录用户可提交想看但站内没有的片（可附年份、外文名、导演主演、备注），每人最多 3 条待处理、可撤销；站长在后台贴链接（磁力/下载/站内/外站均可）或标记"需补充信息 / 无法提供"，用户在「我的求片」查看。
- **封禁**：站长可封禁用户，被封用户整站锁屏，同步与求片接口一律拒绝。

### 站长后台

打开 `https://你的域名/admin`，输入 `ADMIN_TOKEN` 登录（需 `CACHE_TYPE=sqlite`）。

- **概览**：
  - 用户数（按独立密码 / 主密码等类型拆分）、今日 / 7 日 / 30 日活跃、近 7 日新增；
  - 今日与近 30 天观看时长、近 30 天每日柱状图；
  - 热门剧 Top、直播 Top、分享来源分布、待处理求片。
- **用户**：
  - 按用户类型、活跃状态（今日/7日/30日活跃、沉睡、从未观看、已封禁、有求片、有分享）筛选，可搜索；
  - 可按观看时长、观看集数、看过剧数、最近活跃、最近登录、分享带来的打开数等排序；
  - 点开某人可看他看过的每部剧（时长、集数、逐集明细）、近 60 天每日观看、同步历史、分享记录、求片，并可封禁/解封。
- **求片**：
  - 按状态分栏计数，可搜索、按"最多人想看"排序，同一部片多人求会显示"N 人想看"；
  - 处理时可用常用回复模板，支持批量处理。
- **分享**：每条分享的渠道、带来的打开次数（去重）、打开来源、带来的登录。

**观看时长是实测的**：

- 只在视频真的在播（画面在走，暂停/缓冲不算）且页面在前台（或画中画）时计时；
- 4 小时没有任何操作视为挂机，不再计时；
- 每分钟和切走页面时上报，断网时先存本机、恢复后补发（服务器按批次去重，每人每天最多计 24 小时）。

"看过一集" = 这一集实际看了 2 分钟以上，或看到 90%。旧版按进度估算的时长只在用户详情的同步历史里作参考（标"估"）。

**分享来源**：

- 每次分享生成一个短码附在链接上（`&s=`）。
- 有人打开时，服务器按打开者浏览器的 User-Agent 识别是从哪个 App 打开的（微信、QQ、微博、钉钉、Telegram 等），并做去重，不存原始 IP。
- 社交平台抓取链接预览也会记一笔，能看出链接被发到了哪里。

不想统计可设 `STATS_DISABLE=1`。

### 分享深链与 SEO

- **深链**：播放页可分享 `/?play=剧名&ep=集名&t=秒数`（同名多部作品时带 `&w=` 区分），可复制或分享到微信、QQ、Telegram、WhatsApp、Facebook、X、Instagram，或调起系统分享。
- **未登录预览**：未登录的人打开分享链接，只看到标题、简介、海报（来自 `/api/preview`，**不访问任何资源站**），登录后才能播放。
- **社媒卡片**：社交平台爬虫抓取分享链接时，服务器返回带 OpenGraph / Twitter Card 的预览页。
- **SEO**：`/movie/:id`、`/tv/:id` 服务端渲染详情页（含 JSON-LD），以及 `/sitemap.xml`、`/robots.txt`。想固定域名就设 `SITE_URL`。

### TV 模式与偏好设置

**TV 模式**：页面底部按钮开启，或访问 `?tv=1` / `?tv=0`（会记住）。

- **自动开启**：Android TV、Fire TV、Tizen、WebOS、Google TV 等设备会自动开启，Android App 默认开启。
- **遥控器操作**：方向键导航、确认键选择、返回键退出，播放时有专用的倍速、换线路、±10 秒、选集按钮。
- **兼容性检测**：启动时检测 WebView 兼容性，老内核给出提示而不是白屏。

**偏好设置**（页面底部 ⚙️）：

| 选项 | 默认 | 说明 |
|---|---|---|
| 隐藏随机盲盒 | 关 | 首页不显示随机推荐 |
| 过滤成人内容 | 开 | 随机盲盒只出 PG-13 / TV-14 及以下；同时隐藏成人直播频道 |
| 跳过按钮 | 开 | 片头/片尾处显示跳过按钮 |
| 自动跳过片头/片尾 | 关 | 直接跳，不弹按钮 |
| 封面/文字大小 | 标准 | 小 / 标准 / 大 / 特大，跨设备同步 |

---

## Android App

App 是一个 Capacitor 外壳，打开内置的站点地址（默认 `https://ednovas.video`），App ID `com.ednovas.donguatv`，最低 Android 7.0。

- **自动构建**：推送 `v*.*.*` 格式的 tag（如 `git tag v1.0.0 && git push origin v1.0.0`）会触发 GitHub Actions，在 Releases 下载通用 APK。
- **自定义构建**：在 Actions → Android Build & Release → Run workflow 填服务器地址、App 名称、版本号即可，不用改代码。
- **签名**：配置了仓库 Secrets（`SIGNING_KEY` Base64 keystore、`KEY_STORE_PASSWORD`、`ALIAS`、`KEY_PASSWORD`）就用它签名，否则用 debug 签名。
- **图标**：由 `public/icon.png` 自动生成。

<details>
<summary>本地构建</summary>

需要 Node 22+、JDK 21、Android SDK 36。改服务器地址编辑 `capacitor.config.json` 的 `server.url`，改名称编辑 `android/app/src/main/res/values/strings.xml`，改版本编辑 `android/app/build.gradle`。

```bash
npm install && npx cap sync android
cd android && ./gradlew assembleRelease   # 产物是未签名的 app-release-unsigned.apk，需自行签名
```
</details>

App 有问题时，网页版和 PWA（浏览器「添加到主屏幕」）兼容性最好；电视推荐当贝浏览器。

---

## 数据与备份

| 文件 | 内容 |
|---|---|
| `db.json` | 采集源配置 |
| `cache.db`（+ `cache.db-wal` / `-shm`） | SQLite：**用户历史、设置、求片、用户统计与封禁、观看统计、分享记录、片头片尾标记**、弹幕缓存、各类缓存 |
| `cache_search.json` / `cache_detail.json` / `cache_intro.json` / `cache_intro_env.json` | 仅 `CACHE_TYPE=json` 时：缓存与片头片尾标记 |
| `public/cache/images/` | TMDB 图片缓存（上限 1GB，自动淘汰） |

> ⚠️ `cache.db` 不只是缓存，删掉它会丢掉所有用户数据。只想清缓存请不要删它。

备份 SQLite 请用在线备份（不用停服务，也不会漏掉 WAL 里的数据）：

```bash
sqlite3 /opt/dongguaTV/cache.db ".backup '/root/backup/cache-$(date +%F).db'"
cp /opt/dongguaTV/db.json /root/backup/
```

---

## 开发与测试

单文件前端 `public/index.html`（Vue 3），后端 `server.js`（VPS）/ `api/index.js`（Vercel），功能模块在 `lib/`（番剧规则源、剪后清单托管、线路档案、弹幕缓存、用户统计）。

| 回归脚本 | 覆盖 |
|---|---|
| `node scripts/worker-test.mjs` | Worker 去广告规则 |
| `node scripts/adclip-test.mjs` | 播放器剪插播（真实清单回放） |
| `node scripts/hls-cut-test.mjs` | 剪后清单服务器托管 |
| `node scripts/source-list-test.mjs` | 线路分组、拆卡、去重、测速缓存 |
| `node scripts/site-profiles-test.mjs` | 线路档案 |
| `node scripts/kazumi-test.mjs` | 番剧规则源 |
| `node scripts/danmaku-match-test.mjs` | 弹幕候选匹配（约 340 个真实用例回放，含留出集） |
| `node scripts/danmaku-cache-test.mjs` | 弹幕服务器缓存 |
| `node scripts/user-stats-test.mjs` | 观看与分享统计、站长后台接口 |
| `node scripts/watch-meter-test.mjs` | 播放页观看计时（只在真的在播时计、离线合并补发） |
| `node scripts/history-sync-test.mjs` | 观看历史增量同步（只推变化的、瘦身、双设备端到端） |
| `node scripts/check-hls-lc-patch.mjs` | hls.js 音频补丁（升级 hls.js 时必跑） |

- **改了前端库**：`public/sw.js` 里预缓存的库要同时升 `?v=` 和 `CACHE_VERSION`。
- **改了 Worker**：需要重新部署 Worker。

---

## 致谢

由 **kk爱吃王哥呆阿龟头** 设计编写，**ednovas** 优化功能与部署。弹幕借助开源 [danmu_api](https://github.com/huangxd-/danmu_api)；番剧规则取自 [KazumiRules](https://github.com/Predidit/KazumiRules)（MIT，见 `lib/kazumi/rules/NOTICE`）；数据来自 **TMDb** 与各 **Maccms** 接口。

## 免责声明

1. 本项目仅作为 Node.js 与 Vue 3 的学习项目开源。
2. 本项目不内置任何影视资源接口，文档与代码中的地址均为占位示例。
3. 使用者需自行寻找合法接口并遵守当地法律法规。
4. 开发者不存储、不发布、不参与任何视频内容的制作与传播。
