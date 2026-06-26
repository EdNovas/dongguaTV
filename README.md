# E视界 (DongguaTV Enhanced Edition)

现代流媒体聚合播放器，基于 Node.js + Express + Vue 3 构建。原版项目：[Minerchu/dongguaTV](https://github.com/Minerchu/dongguaTV)

相比原版，本作重构了前后端，新增了**实时流式搜索、弹幕、分享深链与未登录预览、TMDB 反代、智能 CORS 代理与边缘去广告、多用户历史云同步、SEO/社媒卡片、Android/PWA/TV 模式**等大量功能。

## 演示

https://ednovas-test.vercel.app （不包含任何数据）

<img width="2547" height="1226" alt="image" src="https://github.com/user-attachments/assets/15392a90-9078-45b6-828d-829402669950" />

<img width="2547" height="1227" alt="image" src="https://github.com/user-attachments/assets/d03543f5-34a4-414b-a131-62eda0af21b2" />

<img width="2547" height="1229" alt="image" src="https://github.com/user-attachments/assets/e8bd4e14-dbd2-4d49-a1fc-7979c1ca22a4" />

---

## 📚 目录

- [✨ 核心特性](#-核心特性)
- [🎨 界面升级](#-界面升级)
- [🛠️ 技术栈](#️-技术栈)
- [🔧 前置准备](#-前置准备)
- [📦 安装与运行](#-安装与运行)
  - [环境变量总表](#环境变量总表)
- [🚀 部署](#-部署)
  - [Docker 部署](#-docker-部署推荐)
  - [Vercel 部署](#-vercel-部署)
  - [PM2 部署](#️-linux-服务器部署-pm2)
  - [宝塔面板部署](#-宝塔面板-aapanel-部署)
- [🔒 安全与高级功能](#-安全与高级功能)
- [🛡️ 广告过滤](#️-广告过滤)
- [📡 直播电视 (IPTV)](#-直播电视-iptv)
- [🗨️ 弹幕](#️-弹幕)
- [🔗 分享、深链与未登录预览](#-分享深链与未登录预览)
- [🔎 SEO 与社媒卡片](#-seo-与社媒卡片)
- [📺 TV 模式](#-tv-模式)
- [🎛️ 偏好设置](#️-偏好设置)
- [🤖 Android APP](#-android-app)
- [💾 数据维护与备份](#-数据维护与备份)
- [⚠️ 免责声明](#️-免责声明)

---

## ✨ 核心特性

### 🎬 双引擎数据驱动
- **TMDb**：高质量电影/剧集元数据（海报、背景图、评分、简介、演职员表）
- **CMS 聚合源 (Maccms)**：集成多个自定义第三方资源站 API，自动**全网测速**，智能过滤失效源

### 🔍 智能搜索与聚合
- **实时流式搜索 (SSE)**：结果边搜边显，即时反馈，源数量实时跳动
- **智能关键词匹配**：自动生成搜索变体（去除副标题、季数后缀等），同时搜索中英文名
- **自动英中翻译**：检测英文搜索词时自动通过 TMDB 获取中文译名（如 "Stranger Things" → "怪奇物语"）
- **自动分组与合并**：同一影片的不同线路自动聚合到一张卡片
- **多级缓存**：SQLite / JSON / 内存，热搜词秒级响应

### 📺 沉浸式播放体验
- **影院模式**：暗色系沉浸布局，剧集网格选择（DPlayer + HLS.js）
- **🗨️ 弹幕**：可挂接自建弹幕聚合服务，聚合爱奇艺/腾讯/优酷/B站/芒果/360 等平台弹幕（需配置 `DANMU_API_URL`，详见[弹幕](#️-弹幕)）
- **双模式测速**：客户端直连测速 + 服务器端兜底测速（`/api/check`），真实反映可用性
- **自动故障转移**：播放失败自动切换下一可用线路
- **倍速播放**：0.5x–2x 调速，选择记忆到本地，TV 模式带专用调速按钮
- **投屏支持**：集成 DLNA/AirPlay 本地投屏（自动保持屏幕常亮）
- **🛡️ 边缘去广告**：通过 CORS 代理在 Cloudflare Worker 边缘按时长剔除 M3U8 广告分段（详见[广告过滤](#️-广告过滤)）

### 📡 直播电视
- **多源聚合**：聚合公开 M3U 直播源（vbskycn + iptv-org），中文频道 + 12 种国际语言，约 **1800 频道 / 22 种类 / 13 语**，服务器侧 6h 缓存并预热
- **语言 × 种类双重筛选**：播放页按【语言】+【种类】两级筛选，分页网格（每页 48、左右翻页箭头、只渲染当前页防卡），并支持「最近观看频道」
- **诚实可达性**：服务器逐源测速，标注「能播/置灰」，绝不让被封的源诈活（CCTV 等央视海外受运营商内网 IP 限制，详见[直播电视](#-直播电视-iptv)）
- **成人频道门控**：站长可经 `LIVE_M3U_ADULT` 注入成人源（本仓库不内置），受前端 NSFW 过滤开关控制显隐
- **直播深链**：直播频道可分享 `?live=频道名`，打开自动定位播放

### 🔗 分享与深链
- **一键分享**：生成 `?play=剧名&ep=集名&t=秒数` 深链，可复制或分享到微信/QQ/Telegram/WhatsApp/Facebook/X/Instagram
- **未登录预览锁定框**：未登录用户打开分享链接，仅展示标题+简介+海报（来自 `/api/preview`，**不访问任何资源站**），登录后解锁播放
- **社媒卡片**：社交爬虫抓取分享链接时返回 OpenGraph / Twitter Card 富预览

### 🌏 大陆用户优化
- **智能 IP 检测**：Cloudflare 头 + `api.ip.sb` 地理库判定大陆/海外，自动切换 TMDB 反代模式（或用 `SERVER_IN_CHINA=true` 强制）
- **本地资源优先**：核心依赖库（Vue、Bootstrap、DPlayer、HLS.js 等）全部本地化部署，无 CDN 依赖，秒开
- **智能 CORS 代理**：资源站直连失败或过慢时自动走代理并"记住"该站点（24h），自动重写 m3u8、绕过防盗链
- **一键安装脚本**：交互式配置

### 📱 多端支持
- **Android App**：沉浸式状态栏，适配刘海屏（Capacitor）
- **PWA**：添加到主屏幕即点即用，Service Worker 离线缓存
- **电视/盒子**：TV 模式遥控器导航，自动检测智能电视；启动屏自带 WebView 兼容性检测

### 🔒 安全与访问控制
- **全局访问密码**：支持记住登录状态 1 年
- **多用户模式**：每个密码一个独立用户，观看历史跨设备云同步
- **接口限流**：按 IP 分级限流（通用 600/分、搜索 120/分、预览 40/分等），并对 TMDB/弹幕上游调用做全站封顶防刷
- **远程配置加载**：`REMOTE_DB_URL` / `SITES_JSON` 多站点统一管理

---

## 🎨 界面升级

| 功能区域 | 原版 | **增强版** |
| :--- | :--- | :--- |
| **首页视觉** | 简单列表 | Netflix 风格 Hero 轮播，全屏动态背景 |
| **导航栏** | 固定顶部 | 智能融合，初始透明，滚动变黑 |
| **搜索框** | 固定位置 | 动态交互，下滑自动吸顶缩小 |
| **榜单浏览** | 有限静态列表 | 无限滚动，20+ 细分榜单 |
| **搜索体验** | 等待 loading | 实时流式加载 (SSE) |
| **线路选择** | 单一延迟 | 双模式测速（直连/代理/服务器兜底） |
| **播放失败** | 手动切换 | 自动故障转移 |
| **启动体验** | 分块加载 | 优雅启动屏 + WebView 兼容性检测 |

---

## 🛠️ 技术栈

| 类别 | 技术 |
|------|------|
| **Frontend** | Vue.js 3 (CDN), Bootstrap 5, FontAwesome 6, DPlayer, HLS.js |
| **Backend** | Node.js, Express, Axios, express-rate-limit |
| **Data Sources** | TMDb API v3, 多个 Maccms CMS API |
| **Deployment** | Docker (多架构), Vercel, PM2, 宝塔面板 |
| **Cache** | SQLite (推荐，better-sqlite3 + WAL), JSON File, Memory |
| **Proxy / Edge** | Cloudflare Workers (TMDB 反代 / CORS 代理 + 去广告), 或自建 `proxy-server.js` |
| **Mobile** | Capacitor (Android), PWA (Service Worker + Manifest) |

---

## 🔧 前置准备

### 1. ⚠️ 配置采集源 (重要)

本项目**不包含**任何内置影视资源接口。需自行添加合法的 Maccms V10 (JSON 格式) 接口。

所有配置存储在 `db.json` 文件中（首次运行自动生成）：

```json
{
  "sites": [
    {
      "key": "unique_key1",
      "name": "站点名称1",
      "api": "https://...",
      "active": true
    }
  ]
}
```

### 2. 获取 TMDb API Key (必需)

1. 注册：[Create Account](https://www.themoviedb.org/signup)
2. 申请 API：[API Settings](https://www.themoviedb.org/settings/api) → **Create**
3. 应用类型选 **Developer**，用途填 "Personal learning project"
4. 复制 **API Key (v3 auth)** 备用

### 3. 大陆用户：部署 TMDB 反代 (可选)

TMDB 在大陆无法直接访问，需要配置反向代理：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create Worker**
2. 复制 `cloudflare-tmdb-proxy.js` 内容到编辑器 → **Save and Deploy**
3. 获取 Worker URL，在 `.env` 中配置：
   ```env
   TMDB_PROXY_URL=https://tmdb-proxy.your-name.workers.dev
   # 若服务器本身在大陆，建议同时设置 SERVER_IN_CHINA=true 强制走反代
   ```

### 4. 资源站 CORS 代理 (可选)

当服务器或用户无法直接访问资源站时，系统自动通过 CORS 代理中转。**边缘去广告也依赖此代理**。

**核心功能：**
- ✅ 智能学习：直连失败或过慢（>1.5s）时自动改走代理，并记住该站点 24h
- ✅ 双延迟比较：仅当直连 >1500ms 且代理快 30% 以上才切换，避免无谓代理
- ✅ m3u8 重写：自动把 ts 分片改写为经代理（ts 视频本身仍由 CDN 直传，不二次代理）
- ✅ 防盗链绕过：上游返回 401/403/404/451 时自动去掉 Referer/Origin 重试
- ✅ 边缘去广告：按时长剔除广告分段（详见[广告过滤](#️-广告过滤)）

**UI 状态标识：** 🟢 直连 ｜ 🟡 中转 ｜ 🔵 服务器测速

#### 方案 A：Cloudflare Workers 部署

> ⚠️ 免费版每日 10 万次请求限制。个人自用通常没问题，多人使用建议用 VPS 方案。

1. Cloudflare → **Workers & Pages** → **Create Worker**
2. 复制 `cloudflare-cors-proxy.js` → **Save and Deploy**
3. 配置 `.env`：
   ```env
   CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev
   ```

#### 方案 B：VPS / Node.js 部署

```bash
npm install express axios cors dotenv
PORT=8080 node proxy-server.js
# 或 PM2 守护：pm2 start proxy-server.js --name cors-proxy
# 可选：设置 PROXY_PASSWORD 后，调用需带 Authorization: Bearer <password>
```

`.env` 配置：`CORS_PROXY_URL=http://your-vps-ip:8080`

### 5. 弹幕服务 (可选)

如需弹幕，需自行部署一个 `danmu_api`（聚合主流平台弹幕、兼容弹弹play 的服务），然后在 `.env` 配置 `DANMU_API_URL`。详见[弹幕](#️-弹幕)章节。

---

## 📦 安装与运行

### 🚀 一键安装脚本 (推荐)

```bash
curl -fsSL https://raw.githubusercontent.com/ednovas/dongguaTV/main/install.sh | bash
```

脚本会引导输入 TMDB API Key、反代地址、运行端口等。

### 手动安装

```bash
# 1. 安装 Node.js v18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. (可选) SQLite 编译工具 —— 使用 CACHE_TYPE=sqlite 时必需
sudo apt-get install -y build-essential python3

# 3. 安装依赖
git clone https://github.com/ednovas/dongguaTV.git
cd dongguaTV && npm install

# 4. 配置环境变量
cp .env.example .env && nano .env

# 5. 启动
node server.js
```

访问 `http://localhost:3000`

### 环境变量总表

| 变量名 | 必填 | 默认 | 说明 |
|--------|------|------|------|
| `TMDB_API_KEY` | ✅ | — | TMDb API 密钥，核心元数据来源 |
| `PORT` | ❌ | `3000` | 服务监听端口 |
| `CACHE_TYPE` | ❌ | `json` | 缓存类型：`json` / `sqlite` / `memory` / `none`。历史同步需 `sqlite` |
| `ACCESS_PASSWORD` | ❌ | — | 访问密码；逗号分隔多个则开启多用户（首个为管理员，不同步） |
| `TMDB_PROXY_URL` | ❌ | — | TMDB 反代地址（大陆用户） |
| `SERVER_IN_CHINA` | ❌ | — | 设为 `true` 时所有 TMDB 请求强制走 `TMDB_PROXY_URL` |
| `CORS_PROXY_URL` | ❌ | — | 资源站/m3u8 的 CORS 代理与边缘去广告地址 |
| `REMOTE_DB_URL` | ❌ | — | 远程 `db.json` 地址（5 分钟缓存，失败回退本地） |
| `SITES_JSON` | ❌ | — | 直接内嵌站点配置（JSON 或 Base64），主要用于 Vercel |
| `DANMU_API_URL` | ❌ | — | 自建 `danmu_api` 地址；配置后开启弹幕。**支持逗号分隔多实例**（并行赛跑、抗限流）。详见[弹幕](#️-弹幕) |
| `DANMU_API_TOKEN` | ❌ | — | `danmu_api` 鉴权令牌；**逗号分隔与多实例按序配对**，单个则共用 |
| `SITE_URL` | ❌ | 自动探测* | 分享卡片/SEO 用的站点根地址 |
| `PROXY_PASSWORD` | ❌ | — | 自建 `proxy-server.js` 的 Bearer 鉴权口令 |
| `ADMIN_TOKEN` | ❌ | — | 站长令牌，**也是「求片」功能的总开关**：不设则求片整体关闭（前端隐藏入口、后端拒收）。设置后用户可提交求片（含外文名/年份/导演主演等信息，单人最多 3 条待处理、可自行撤销），站长在求片弹窗"站长管理"里输入它即可看全部求片，并贴链接履行（下载/磁力/站内播放/外站均可）或标记"需补充信息 / 无法提供" |
| `LIVE_M3U_URL` | ❌ | `live.zbds.top/tv/iptv4.m3u` | 直播主源 M3U（vbskycn）。详见[直播电视](#-直播电视-iptv) |
| `LIVE_M3U_FALLBACK` | ❌ | gh-proxy 镜像 | 主源拉取失败时的备源 |
| `LIVE_M3U_IPTVORG` | ❌ | iptv-org `countries/cn.m3u` | 中文频道补充源 |
| `LIVE_M3U_EXTRA` | ❌ | — | 自定义上游 M3U（逗号分隔多个），用于注入**付费 IPTV 的 m3u**——海外稳定播 CCTV5/5+ 的唯一可靠路 |
| `LIVE_M3U_ADULT` | ❌ | — | 成人直播源（逗号分隔），归"成人"分类，受前端 NSFW 过滤开关控制显隐；仓库**不内置任何地址** |
| `LIVE_TV_DISABLED` | ❌ | — | 设为 `1` 整体关闭直播（前端隐藏直播区、`/api/live/channels` 返回 `enabled:false`） |
| `LIVE_NO_VALIDATE` | ❌ | — | 设为 `1` 跳过服务端逐源测速验证（默认开启，用于标注频道能播/置灰） |

> \* `SITE_URL` 未设置时自动从请求 `Host`/`X-Forwarded-Host` 头推断，最终回退为 `https://ednovas.video`。
>
> 💡 注：`DANMU_API_URL`、`DANMU_API_TOKEN`、`SERVER_IN_CHINA`、`SITE_URL`、`PROXY_PASSWORD` 这几项当前未写入 `.env.example`，但代码均已支持，按需在 `.env` 中直接添加即可。

---

## 🚀 部署

### 🐳 Docker 部署（推荐）

> **🎉 多架构支持**：自动匹配 `linux/amd64`、`linux/arm64`、`linux/arm/v7`

镜像同时发布到 **GitHub Container Registry** 和 **Docker Hub**，选择任一即可：

| 镜像源 | 地址 |
|--------|------|
| **Docker Hub** | `docker.io/ednovas/dongguatv:latest` |
| **GHCR** | `ghcr.io/ednovas/dongguatv:latest` |

> 💡 如果 `ghcr.io` 拉取报 `manifest unknown`，请使用 Docker Hub 镜像或升级 Docker 到 20.10+。

#### 快速启动

```bash
docker run -d -p 3000:3000 \
  -e TMDB_API_KEY="your_api_key_here" \
  -e ACCESS_PASSWORD="your_password" \
  --name donggua-tv \
  --restart unless-stopped \
  ednovas/dongguatv:latest
```

#### 完整配置（持久化数据）

```bash
# 1. 先创建文件，防止 Docker 将其识别为目录
touch db.json cache.db
echo '{"sites":[]}' > db.json
mkdir -p cache/images

# 2. 启动
docker run -d -p 3000:3000 \
  -e TMDB_API_KEY="your_api_key_here" \
  -e ACCESS_PASSWORD="your_password" \
  -e TMDB_PROXY_URL="https://tmdb-proxy.your-name.workers.dev" \
  -e CORS_PROXY_URL="https://cors-proxy.your-name.workers.dev" \
  -e DANMU_API_URL="https://your-danmu-api.workers.dev" \
  -e REMOTE_DB_URL="https://example.com/db.json" \
  -v $(pwd)/db.json:/app/db.json \
  -v $(pwd)/cache.db:/app/cache.db \
  -v $(pwd)/cache/images:/app/public/cache/images \
  --name donggua-tv \
  --restart unless-stopped \
  ednovas/dongguatv:latest
```

> ⚠️ 如果报错 `EISDIR: illegal operation on a directory`，说明没有先创建文件。执行 `rm -rf db.json && touch db.json` 后重试。

#### Docker Compose

```yaml
services:
  donggua-tv:
    image: ednovas/dongguatv:latest
    container_name: donggua-tv
    ports:
      - "3000:3000"
    environment:
      - TMDB_API_KEY=your_api_key_here
      - TMDB_PROXY_URL=https://tmdb-proxy.your-name.workers.dev
      - CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev
      - ACCESS_PASSWORD=your_secure_password
      - REMOTE_DB_URL=https://example.com/db.json
    volumes:
      - ./db.json:/app/db.json
      - ./cache.db:/app/cache.db
    restart: unless-stopped
```

```bash
touch db.json cache.db
docker compose up -d
```

#### 本地构建镜像

```bash
docker build -t donggua-tv .
docker run -d -p 3000:3000 -e TMDB_API_KEY="your_key" --name donggua-tv donggua-tv
```

---

### ▲ Vercel 部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV&env=TMDB_API_KEY,SITES_JSON,REMOTE_DB_URL,ACCESS_PASSWORD,TMDB_PROXY_URL&envDescription=TMDB_API_KEY%20is%20required.%20Use%20SITES_JSON%20(Base64)%20or%20REMOTE_DB_URL%20for%20site%20config.&envLink=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV%23-vercel-%E9%83%A8%E7%BD%B2)

#### 环境变量配置

在 **Settings → Environment Variables** 中添加：

- `TMDB_API_KEY`（必填）
- `REMOTE_DB_URL` 或 `SITES_JSON`（二选一，推荐 `SITES_JSON`）
- `ACCESS_PASSWORD`、`TMDB_PROXY_URL`、`DANMU_API_URL`（可选）

> **SITES_JSON 用法：** 直接填入 JSON 或 Base64 编码的 db.json 内容：
> ```
> SITES_JSON={"sites":[{"key":"ffzy","name":"非凡影视","api":"https://api.ffzyapi.com/api.php/provide/vod/"}]}
> ```

#### 常见问题

| 问题 | 解决 |
|------|------|
| 环境变量不生效 | 修改后必须 **Redeploy** |
| 显示 missing | 检查变量名大小写，确认勾选 **Production** |
| 诊断 | 访问 `/api/debug` 查看运行状态 |

#### Vercel 限制

由于 Serverless 无法持久化文件系统：

- ❌ SQLite 缓存（自动改用内存缓存）
- ❌ 本地图片缓存
- ❌ 本地 db.json（必须配置 `REMOTE_DB_URL` 或 `SITES_JSON`）
- ❌ 多用户历史同步（需要持久化存储）

---

### 🖥️ Linux 服务器部署 (PM2)

```bash
# 安装 Node.js + PM2
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pm2

# 获取代码
git clone https://github.com/ednovas/dongguaTV.git
cd dongguaTV && npm install
cp .env.example .env && nano .env

# 启动并设置开机自启
pm2 start server.js --name "donggua-tv"
pm2 save && pm2 startup
```

---

### 🏰 宝塔面板 (aaPanel) 部署

1. **软件商店** 安装 **Node.js 版本管理器** (v18+)
2. SSH 安装编译工具（`CACHE_TYPE=sqlite` 时需要）：
   ```bash
   # Ubuntu/Debian
   sudo apt-get install build-essential python3 -y
   # CentOS
   sudo yum groupinstall "Development Tools" -y && sudo yum install python3 -y
   ```
3. **网站** → **Node 项目** → **添加**，启动选项 `server.js`，端口 `3000`
4. 配置 `.env` 文件，重启服务
5. 映射/绑定域名

---

## 🔒 安全与高级功能

### 全局访问密码

```env
ACCESS_PASSWORD=your_secure_password
```

开启后访问任何页面都需要密码，登录状态最长记住 1 年。

### 远程配置文件

```env
REMOTE_DB_URL=https://example.com/my-config/db.json
```

> 5 分钟内存缓存，远程失败自动降级到本地 db.json。

### 多用户模式与历史同步

多个密码用逗号分隔，每个密码代表一个独立用户：

```env
ACCESS_PASSWORD=admin_password,user1_pass,user2_pass
```

| 密码位置 | 行为 |
|---------|------|
| 第一个 | 传统模式，历史仅存本地 |
| 第二个及之后 | 云同步，历史跨设备同步 |

**同步特性：** 自动同步 · 本地优先 · 智能合并（以最新观看记录为准） · 隐蔽状态提示。
（端点：`/api/history/pull`、`/api/history/push`、`/api/history/clear`）

> ⚠️ 历史同步**仅在 `CACHE_TYPE=sqlite` 模式下可用**。

### 接口限流

服务端内置按真实客户端 IP（`CF-Connecting-IP` / `X-Real-IP`，含 IPv6 子网归一）的分级限流：通用 API 600/分、搜索 120/分、预览 40/分等；并对 TMDB、弹幕等上游调用做**全站每分钟封顶**，防止被人用伪造 IP + 变换参数刷成放大器。

---

## 🛡️ 广告过滤

去广告在 **Cloudflare Worker（CORS 代理）边缘侧**完成，因此**需先配置 `CORS_PROXY_URL`** 并让 m3u8 经代理加载（直连不经代理时不去广告）。

### 工作原理

代理在改写 m3u8 时（`cloudflare-cors-proxy.js` 的 `rewriteM3u8`）：

1. **按时长剔除广告段组**：识别 `#EXT-X-DISCONTINUITY` 标记切出的分段组，剔除"时长约 3–120 秒且分片数 <15"的可疑广告组；
2. **去内联追踪/广告分片**：丢弃时长极短（<0.5s）的非 ts 追踪分片，以及指向 `.vip`/`.bet`/`.casino`/`.top`/`.xyz`/`.buzz`/`.click` 等可疑 TLD 的分片；
3. **清理 SSAI 标签**：去除 `#EXT-X-CUE`、`#EXT-X-DATERANGE`、`#EXT-X-SCTE35` 等服务端插播元数据；
4. **正片直传**：真正的 ts 视频分片仍由源站 CDN 直接拉取，不经代理二次中转。

> 说明：广告判定基于**分段时长/数量启发式**，而非维护广告平台域名黑名单。客户端仅决定"是否把该 m3u8 交给代理"，实际剔除发生在边缘。

---

## 📡 直播电视 (IPTV)

聚合公开 M3U 直播源（默认 [vbskycn/iptv](https://github.com/vbskycn/iptv) + [iptv-org](https://github.com/iptv-org/iptv)），在首页提供「直播频道」入口，复用现有播放器（DPlayer + HLS.js，靠 `currentGroup._isLive` 与点播区分）。涵盖**中文频道 + 12 种国际语言**，约 **1800 频道 / 22 种类 / 13 语**，服务器侧 6 小时缓存并启动预热。

### 频道组织与筛选

- **语言 × 种类双重筛选**：播放页顶部两行筛选——【语言】（中文 / English / Español / Français / Deutsch / Русский / العربية / Português / Italiano / 日本語 / 한국어 / हिन्दी / Tiếng Việt）+【种类】（央视/卫视/体育/电影/电视剧/新闻/纪实/少儿/音乐…，**随当前语言动态显示该语言下实际存在的类**）。
- **分页网格**：每页 48 个频道，网格左右两侧翻页箭头（随网格滚动常驻视口）+ 底部页码；切换语言/种类自动回到第 1 页。**只渲染当前页**，上千频道也不卡顿。
- **最近观看频道**：记录最近打开的频道（本地存储 + 跨设备同步），可单个删除或一键清空。
- **跟随封面大小**：频道卡尺寸随「偏好设置」里的封面/文字大小（`--ui-scale`）一起缩放。
- **分享深链**：直播频道可分享 `?live=频道名` 深链，打开后自动定位并播放该频道。

### 可达性与限制（重要）

- 直播多为 **http 运营商源**，浏览器混合内容 + 跨域限制 → **必须配置 `CORS_PROXY_URL`（Cloudflare Worker）** 才能播。**智能路由**：https 源由浏览器直连（可走用户自己的国内代理）、http 源经 Worker 升级 https。
- 服务器侧对每个频道首源做**可达性测速**（能识别 backup/待机占位/无信号），标注「能播 / 不能播」，能播的排前、不能播的**置灰**——只如实标注，**不会让被封的源诈活**。测速本身也依赖 `CORS_PROXY_URL`（**未配代理则不测速、不置灰**）；可用 `LIVE_NO_VALIDATE=1` 跳过验证。
- **CCTV 等央视频道海外通常放不了**：它们多为运营商内网 IP（地域 + 版权封锁），CF 边缘从境外发起的回源会被运营商拒（**与用户自己的 IP 无关**）。CGTN、CCTV-4/9/13、各卫视、国际频道一般可看。**想稳定看 CCTV5/5+ 的唯一可靠路 = 用 `LIVE_M3U_EXTRA` 注入付费 IPTV 的 https m3u**（智能路由直连、可走国内代理）。

### 成人频道（可选，默认隐藏）

站长可用 `LIVE_M3U_ADULT`（逗号分隔）注入成人直播源——**本仓库不内置任何色情地址**。这些频道归入「成人」分类，受前端**「成人内容过滤」（NSFW）开关**控制：默认开启 = 隐藏，关闭后才会在筛选里出现「成人」类。

> 设 `LIVE_TV_DISABLED=1` 可整体关闭直播。直播功能面向 **VPS / 自托管**；Vercel 部署未挂直播端点 → 那边直播区自动隐藏（优雅降级）。

---

## 🗨️ 弹幕

播放器可挂接弹幕，数据来自一个**自建的第三方弹幕聚合服务 `danmu_api`**（[huangxd-/danmu_api](https://github.com/huangxd-/danmu_api)，兼容弹弹play、聚合爱奇艺/腾讯/优酷/B站/芒果/360 等平台）。本站后端把"剧名+集名"映射到该服务、抓取并转成 DPlayer v3 格式喂给播放器。

### 启用方式

1. 自行部署一个 `danmu_api` 服务（**推荐 Docker/Node 自托管**，原因见下文「部署选择」）。
2. 配置环境变量：
   ```env
   # 单实例：
   DANMU_API_URL=https://your-danmu-api.example.com
   DANMU_API_TOKEN=your_token
   # 多实例（逗号分隔，多出口 IP 抗限流）：哪个先返回非空就用谁（并行赛跑）
   DANMU_API_URL=http://127.0.0.1:9321,https://backup-danmu.example.com
   DANMU_API_TOKEN=token1,token2          # 逗号分隔与各实例配对；只填一个则全部共用
   ```
3. 重启服务。**未配置 `DANMU_API_URL` 时弹幕优雅降级**（返回空、不报错、不影响播放）。

### 前端弹幕设置（播放器内）

控制栏有独立的「弹幕设置」按钮（视频设置齿轮左侧），点开滑块面板可调，且**全部跨设备同步**（存 `user_settings`）：

| 项 | 说明 |
|---|---|
| 显示弹幕 / 海量弹幕 | 开关（海量=允许重叠不丢弃） |
| 行数 | 弹幕占屏行数 1–20（按单行高换算容器限高） |
| 速度 | Lv.1–10，越大越快（动画时长 20s→2s） |
| 字号 | 12–44px |
| 字体 | 默认 / 微软雅黑 / 黑体 / 宋体 / 楷体 / 仿宋（子列表每项以各自字体显示） |
| 不透明度 | 10–100% |

弹幕设置面板与视频设置（齿轮）互斥；菜单开着点视频画面 = 关菜单 + 隐藏控制栏（不暂停）。倍速跨集保持（本地记住）。

### 后端抓取与缓存

- 端点：`GET /api/danmaku/v3/?id=<剧名|集名>`（DPlayer 约定）。
- **主标题归一**（去 `(2022)`/`【国产剧】` 等后缀，防"破事精英"误配"破事精英 第二季"）、**集号识别**（抓"第N集/话/期"、忽略剧名数字）、**平台回退排序**（爱奇艺/腾讯/优酷/360 优先，跳过常空的源）。
- **多实例并行赛跑**：`DANMU_API_URL` 多实例时 `Promise.any` 并发，第一个非空即用——某实例卡死/限流不拖累其它。
- **缓存**：搜索结果按剧名短缓存（同剧各集复用）；非空弹幕长缓存（7 天 + 30 天 stale-while-revalidate）；**空/出错一律 `no-store`**（绝不让 CDN/浏览器缓存"暂时为空"，否则某集偶发取空会被长期冻结）。单集上限 12000 条按时间均匀采样。
- **防刷**：上游查询全站每分钟封顶。

### `danmu_api` 推荐配置参数

> 下面是 **`danmu_api` 服务自身**的环境变量（不是本站的）。经实测，这几项对"快、稳、不被限"最关键：

| 参数 | 建议值 | 作用 |
|---|---|---|
| `TOKEN` | 自定义 | API 鉴权令牌（与本站 `DANMU_API_TOKEN` 对应） |
| `RATE_LIMIT_MAX_REQUESTS` | `0` | 关闭每 IP 限流——本站是单服务器代理、整站流量同一 IP，默认 `3/分` 会被限成大量 429 |
| `SOURCE_ORDER` | `360`（国产剧）| "搜索匹配"源；`360` 一次聚合即定位 爱奇艺/腾讯/B站。**别用默认含 `douban`**（它内部串多平台、最慢） |
| `PLATFORM_ORDER` | `qiyi,qq` | 优先取哪个平台的弹幕（爱奇艺/腾讯最多最稳；B站维护成本高、对国产剧弱） |
| `OTHER_SERVER` | 一个可用的 danmu_api 地址 | **兜底**：自家抓空时转它（借其干净出口 IP），治"整集没弹幕" |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | 免费 Upstash | **持久缓存**——serverless 上没它，剧集临时 ID 映射跨请求即丢 → `comment not found`，配上即根治 |
| `BILIBILI_COOKIE` | B站 `SESSDATA` | 绕过 B站 对机房 IP 的风控（仅 B站 这一路需要） |
| `VOD_REQUEST_TIMEOUT` | `6000` | 单源超时（默认 10s），调小让慢源快速失败 |

### 部署选择（重要）

- **CF Workers / Netlify / Vercel（serverless）**：共享出口 IP，常被弹幕平台**按 IP 限流/风控**（繁忙节点会 0 字节挂死）；CF Workers 还有**单请求子请求上限**（免费版 50，长视频会"后半段没弹幕"），内存缓存跨请求/跨节点失效（**必须配 Redis**，否则频繁 `comment not found`）。
- **✅ 推荐：Docker/Node 自托管**（自己的 VPS）：专用 IP 不易被限、**无子请求上限**（长视频弹幕抓全）、单进程内存常驻（ID 映射不丢、可不依赖 Redis）。本站 `DANMU_API_URL` 指向 `http://127.0.0.1:9321` 即可：
  ```bash
  docker run -d --name danmu-api --restart unless-stopped -p 127.0.0.1:9321:9321 \
    -e TOKEN=your_token -e RATE_LIMIT_MAX_REQUESTS=0 \
    -e SOURCE_ORDER=360 -e PLATFORM_ORDER=qiyi,qq \
    -v /opt/danmu/cache:/app/.cache logvar/danmu-api:latest
  ```

---

## 🔗 分享、深链与未登录预览

### 分享深链

播放页可一键生成深链并复制 / 分享到微信、QQ、Telegram、WhatsApp、Facebook、X、Instagram（App 内走原生分享）：

```
https://your-site.com/?play=剧名&ep=集名&t=秒数
```

打开深链会自动（必要时先登录）搜索并定位到对应剧集、从指定时间点续播。

### 未登录预览锁定框

未登录用户打开分享深链时，会看到一个**锁定预览框**：仅显示标题、TMDB 简介与海报，播放器为黑屏并提示登录。该预览数据来自 `GET /api/preview?name=<剧名>`，**全程不搜索、不访问任何资源站**，登录后才解锁真正播放。

接口侧带内存缓存（命中 6h、未命中 10min）+ 单 IP 限流（40/分）+ 全站 TMDB 调用封顶（300/分），避免被当作 TMDB 放大器。

### 社媒卡片

当社交平台爬虫（按 User-Agent 识别）抓取 `/?play=剧名` 时，服务器返回带 OpenGraph / Twitter Card 的富预览页（标题/海报/简介），普通用户照常拿到 SPA。

---

## 🔎 SEO 与社媒卡片

为便于搜索引擎收录与社交分享，服务端额外提供：

| 路径 | 说明 |
|------|------|
| `/movie/:id`、`/tv/:id` | 服务端渲染的影片详情页，含 OpenGraph、Twitter Card、JSON-LD 结构化数据与 canonical 链接 |
| `/sitemap.xml` | 自动生成的站点地图 |
| `/robots.txt` | 动态注入当前站点地址（取 `SITE_URL` 或自动探测的 Host） |

如需保证卡片/规范链接使用固定域名，设置 `SITE_URL=https://your-domain.com`。

---

## 📺 TV 模式

页面底部提供 TV 模式切换入口，支持遥控器方向键导航。

| 操作 | 效果 |
|------|------|
| 点击底部 📺 TV 按钮 | 切换 TV 模式 |
| URL `?tv=1` / `?tv=0` | 手动控制 |

**TV 模式特性：** 方向键导航 · 焦点高亮 · 确认键选择 · 返回键退出 · 专用倍速/换源按钮

**自动检测：** Android TV · Fire TV · Samsung Tizen · LG WebOS · Roku · Chromecast

> 启动时会做 WebView 兼容性检测（Proxy/fetch/Promise 等），老旧电视盒子内核不支持时给出提示而非白屏。

---

## 🎛️ 偏好设置

页面底部 ⚙️ 偏好设置按钮，配置自动保存到 `localStorage`。

| 选项 | 说明 | 默认 |
|------|------|------|
| 隐藏随机盲盒 | 关闭首页随机推荐板块 | 关闭 |
| 过滤成人内容 | 按 MPAA（隐藏 NC-17）与电视分级（隐藏 TV-MA）过滤 | **开启** |

---

## 🤖 Android APP

### 自动构建 (GitHub Actions)

推送 `v*.*.*` 格式的 Tag 时自动触发构建，在 **Releases** 页面下载 APK（通用包，含 armeabi-v7a / arm64-v8a / x86 / x86_64）。

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 自定义构建

无需修改代码，在 GitHub **Actions** → **Android Build & Release** → **Run workflow** 中填入：
- Server URL、App Name、Version Tag

构建会自动从站点图标生成应用图标并签名（有 Release 签名密钥则用之，否则回退 debug 签名）。

### 默认配置

| 配置项 | 值 |
|--------|-----|
| App 名称 | E视界 |
| 默认服务器 | `https://ednovas.video` |
| App ID | `com.ednovas.donguatv` |
| 图标来源 | 自动从 `public/icon.png` 生成 |

### 代码修改 (高级)

<details>
<summary>点击展开</summary>

**修改服务器地址：** 编辑 `capacitor.config.json` 的 `server.url`

**修改 App 名称：** 编辑 `android/app/src/main/res/values/strings.xml`（`capacitor.config.json` 的 `appName` 不会自动同步到原生工程）

**修改版本号：** 编辑 `android/app/build.gradle` 的 `versionCode` / `versionName`

**本地构建：**
```bash
npm install && npx cap sync android
cd android && ./gradlew assembleRelease
```
APK 位于 `android/app/build/outputs/apk/release/`

</details>

### ⚠️ App 问题与替代方案

遇到安装失败、闪退、播放异常等问题？推荐以下替代方案：

1. **🌐 网页版（推荐）** — 兼容性最好，无需安装，电视推荐当贝浏览器
2. **📺 投屏播放** — 点击「一键投屏」，支持 DLNA/AirPlay
3. **📱 PWA 模式** — 浏览器中「添加到主屏幕」

---

## 💾 数据维护与备份

核心数据文件：

| 文件 | 说明 |
|------|------|
| `db.json` | 采集源配置（重要） |
| `cache.db` | SQLite 缓存数据库（含用户观看历史） |
| `cache_search.json` / `cache_detail.json` | JSON 模式缓存 |

```bash
# 备份
mkdir -p ~/backup
cp /opt/dongguaTV/db.json ~/backup/
[ -f /opt/dongguaTV/cache.db ] && cp /opt/dongguaTV/cache.db ~/backup/

# 清理缓存
rm /opt/dongguaTV/cache.db  # 或 rm /opt/dongguaTV/cache_*.json
pm2 restart donggua-tv
```

---

## 📝 贡献与致谢

本项目由 **kk爱吃王哥呆阿龟头** 设计编写，**ednovas** 优化了功能和部署流程。弹幕能力借助开源 `danmu_api`（聚合主流平台、兼容弹弹play）。数据由 **TMDb** 和各式 **Maccms** API 提供。

---

## ⚠️ 免责声明

1. **仅供学习交流**：本项目仅作为 Node.js 和 Vue 3 的学习练手项目开源。
2. **API 说明**：本项目不内置任何有效的影视资源采集接口，文档/代码中的地址仅为占位示例。
3. **自行配置**：使用者需自行寻找合法的 Maccms V10/JSON 接口，并遵守相关法律法规。
4. **内容无关**：开发者不存储、不发布、不参与任何视频内容的制作与传播。

---

*Enjoy your movie night! 🍿*
