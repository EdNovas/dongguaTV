# E视界 (DongguaTV Enhanced Edition)

这是一个经过全面重构和升级的现代流媒体聚合播放器，基于 Node.js 和 Vue 3 构建。相比原版 https://github.com/Minerchu/dongguaTV ，本作添加了许多功能。

# 演示网站

https://ednovas-test.vercel.app （不包含任何数据）

<img width="2547" height="1226" alt="image" src="https://github.com/user-attachments/assets/15392a90-9078-45b6-828d-829402669950" />

<img width="2547" height="1227" alt="image" src="https://github.com/user-attachments/assets/d03543f5-34a4-414b-a131-62eda0af21b2" />

<img width="2547" height="1229" alt="image" src="https://github.com/user-attachments/assets/e8bd4e14-dbd2-4d49-a1fc-7979c1ca22a4" />


---

## 📚 目录 (Table of Contents)

- [✨ 核心特性 (Features)](#-核心特性-features)
- [🎨 界面升级 (UI Upgrade)](#-界面升级-ui-upgrade)
- [🛠️ 技术栈 (Tech Stack)](#️-技术栈-tech-stack)
- [🔧 前置准备 (Prerequisites)](#-前置准备-prerequisites)
- [🌐 网络优化 & 代理 (Network & Proxy)](#-网络优化--代理-network--proxy)
- [🔒 安全与高级功能 (Security & Advanced)](#-安全与高级功能-security--advanced)
- [🛡️ 广告过滤功能](#️-广告过滤功能)
- [📺 TV 模式切换](#-tv-模式切换)
- [🎛️ 偏好设置](#️-偏好设置)
- [📦 安装与运行 (Installation)](#-安装与运行-installation)
- [🚀 部署 (Deployment)](#-部署-deployment)
- [🤖 Android APP 构建](#-android-app-构建-github-actions)
- [⚠️ App 问题与替代方案](#️-app-使用问题与替代方案)
- [💾 数据维护与备份](#-数据维护与备份)
- [⚠️ 免责声明 (Disclaimer)](#️-免责声明-disclaimer)

---

## ✨ 核心特性 (Core Features)

### 1. 🎬 双引擎数据驱动
- **TMDb (The Movie Database)**：提供高质量的电影/剧集元数据（海报、背景图、评分、简介、演职员表）。
- **CMS 聚合源 (Maccms)**：可集成多个自定义第三方资源站 API，自动进行**全网测速**，智能过滤失效源，确保播放流畅。

### 2. 🔍 智能搜索与聚合
- **实时流式搜索 (SSE)**：采用 Server-Sent Events 技术，搜索结果**边搜边显**，即时反馈，无需等待所有源响应。
- **智能关键词匹配**：自动生成搜索变体（去除副标题、季数后缀等），同时搜索中英文名，大幅提高命中率。
- **自动英中翻译**：检测到英文搜索词时，自动通过 TMDB 获取中文译名并一起搜索（如搜索 "Stranger Things" 会自动添加 "怪奇物语"），无需外部翻译 API。
- **自动分组与实时合并**：同一影片的不同线路自动聚合，新搜索到的源实时合并到已有卡片，右上角源数量实时跳动。
- **SQLite 永久缓存**：内置高性能 SQLite 数据库缓存，支持无限存储，读写速度极快，热搜词秒级响应。

### 3. 📺 沉浸式播放体验
- **影院模式**：全新设计的播放详情页，采用暗色系沉浸布局，支持剧集网格选择。
- **智能线路测速**：支持用户端直连测速和服务器代理测速，真实反映视频可用性。
- **自动故障转移**：播放失败时自动切换到下一个可用线路，无需手动操作。
- **投屏支持**：集成 DLNA/AirPlay 本地投屏功能（需浏览器支持）。
- **🛡️ 智能广告过滤**：自动检测并过滤 M3U8 流中的广告分段，支持百度、腾讯、阿里、字节等国内主流广告平台。

### 4. 🌏 大陆用户优化
- **智能 IP 双重检测**：采用 **Cloudflare Trace + ipapi.co** 双重检测机制，准确率高且无 API 速率限制，自动切换到 TMDB 反代模式。
- **本地资源优先**：核心依赖库（Vue, Bootstrap, DPlayer 等）均本地化部署，彻底解决 CDN 劫持或加载缓慢问题，秒开无压力。
- **一键安装脚本**：支持交互式配置 API Key、反代地址、运行端口。

### 5. 📱 多端支持
- **Android App**：基于现代 Web 技术封装，支持**沉浸式状态栏 (Immersive Status Bar)**，顶部无黑边，内容自动适配刘海屏，体验原生级流畅。
- **PWA 支持**：支持添加到主屏幕，即点即用。
- **电视/盒子**：推荐使用电视浏览器（如当贝浏览器）直接访问网页版，兼容性最佳。
- **📺 TV 模式切换**：页面底部提供隐蔽的 TV 模式切换入口，一键开启遥控器导航模式，适配智能电视/盒子。

### 6. 🔒 安全与访问控制
- **全局访问密码**：支持设置全局访问密码，且支持**记住登录状态长达 1 年**，既安全又便捷。
- **远程配置加载**：支持从远程 URL 加载 `db.json` 配置文件，方便多站点统一管理。


---

## 🎨 界面与交互升级 (UI/UX Upgrades)

相比原版，我们在 UI/UX 上做了颠覆性的改进：

| 功能区域 | 原版体验 | **MAX 版体验** |
| :--- | :--- | :--- |
| **首页视觉** | 简单的列表罗列 | **Netflix 风格 Hero 轮播**：全屏动态背景、高斯模糊遮罩、Top 10 排名特效。 |
| **导航栏** | 固定顶部 | **智能融合导航**：初始透明，滚动变黑；分类点击自动平滑滚动定位。 |
| **搜索框** | 顶部固定位置 | **动态交互搜索栏**：初始占满全屏，下滑自动吸顶并缩小为"胶囊"悬浮。 |
| **榜单浏览** | 有限的静态列表 | **无限滚动 (Infinite Scroll)**：20+ 个细分榜单，支持向右无限加载。 |
| **搜索体验** | 需等待 loading 结束 | **实时流式加载 (SSE)**：结果即时呈现，源数量实时跳动增加，拒绝枯燥等待。 |
| **线路选择** | 单一延迟显示 | **双模式测速**：区分"直连"(用户端)和"代理"(服务器端) 测速，更准确。 |
| **播放失败** | 需手动切换 | **自动故障转移**：检测播放失败后自动切换到下一可用线路。 |
| **启动体验** | 页面分块加载 | **优雅启动屏**：新增应用级启动画面，资源加载完成后丝滑过渡，拒绝白屏。 |
| **分类系统** | 仅支持搜索跳转 | **全直达榜单**：历史、冒险、综艺等分类均拥有独立的数据流榜单。 |

---

## 🛠️ 技术栈 (Tech Stack)

| 类别 | 技术 |
|------|------|
| **Frontend** | Vue.js 3 (CDN), Bootstrap 5, FontAwesome 6, DPlayer, HLS.js |
| **Backend** | Node.js, Express, Axios |
| **Data Sources** | TMDb API v3, 48+ Maccms CMS APIs |
| **Deployment** | Docker, Vercel, PM2, 宝塔面板 |
| **Cache** | Flexible: SQLite (Recommended), JSON File, or Memory |
| **Proxy** | Cloudflare Workers (for China users) |

---

## 🔧 前置准备

### 1. ⚠️ 配置采集源 (重要)

本项目**不包含**任何内置的影视资源接口。在运行项目前（或运行后），您必须自行添加合法的 Maccms V10 (JSON格式) 接口才能搜索和播放视频。

**配置方法：**
所有的采集源配置均存储在根目录的 `db.json` 文件中。

1.  项目初次运行时会自动生成 `db.json`（如果未生成，可以手动创建或使用模板）。
2.  打开 `db.json`，找到 `sites` 数组。
3.  填入您找到的采集接口信息：

```json
{
  "sites": [
    {
      "key": "unique_key1",       // 唯一标识符（英文字母，不可重复）
      "name": "站点名称1",         // 显示在界面的名称
      "api": "https://...",      // Maccms V10/JSON 接口地址
      "active": true             // 是否启用 (true/false)
    },
    {
      "key": "unique_key2",       // 唯一标识符（英文字母，不可重复）
      "name": "站点名称2",         // 显示在界面的名称
      "api": "https://...",      // Maccms V10/JSON 接口地址
      "active": true             // 是否启用 (true/false)
    }
  ]
}
```
4.  保存文件并**重启服务**。

### 2. 获取 TMDb API Key (必需)
本项目依赖 **The Movie Database (TMDb)** 提供影视元数据。

1.  注册账户：访问 [Create Account](https://www.themoviedb.org/signup) 注册并登录。
2.  申请 API：访问 [API Settings](https://www.themoviedb.org/settings/api)，点击 **"Create"** 或 **"click here"** 申请。
3.  填写信息：应用类型选择 **"Developer"**，简单填写用途（如 "Personal learning project"）。
4.  获取 Key：申请通过后，复制 **"API Key (v3 auth)"** 备用。

### 3. 大陆用户：部署 TMDB 反代 (可选)

由于 TMDB 在大陆无法直接访问，需要配置反向代理以正常显示海报和影视信息。

#### 方案一：部署 Cloudflare Workers 反代 (推荐)

1.  **登录 Cloudflare**
    - 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/)
    - 选择左侧菜单 **"Workers & Pages"** → **"Create application"** → **"Create Worker"**

2.  **部署反代代码**
    - 给 Worker 取名（如 `tmdb-proxy`），点击 **Deploy**
    - 部署后点击 **"Edit code"**
    - 复制 `cloudflare-tmdb-proxy.js` 文件内容，粘贴到编辑器
    - 点击 **"Save and Deploy"**

3.  **获取 Worker URL**
    部署成功后获得 URL，如：`https://tmdb-proxy.your-name.workers.dev`

4.  **稍后在安装时配置**
    在 `.env` 文件中添加：
    ```env
    TMDB_PROXY_URL=https://tmdb-proxy.your-name.workers.dev
    ```

### 4. 资源站 CORS 代理 (可选/推荐)

当服务器或用户无法直接访问某些资源站时，系统会自动通过 CORS 代理中转请求。

#### 支持的场景

| 场景 | 描述 |
|------|------|
| **服务器端搜索** | 服务器无法访问资源站 API 时，自动通过代理搜索 |
| **服务器端获取详情** | 同上，获取影片详情时自动回退到代理 |
| **用户端视频播放** | 用户浏览器无法访问视频流时，自动代理播放 |
| **慢速线路优化** | 直连延迟 >1500ms 时，自动尝试代理，选择更快的方式 |

#### 核心功能

- ✅ **智能学习**：自动记住需要代理的站点（24小时有效期）
- ✅ **慢速检测**：直连延迟超过 1.5 秒时，自动测试代理是否更快
- ✅ **m3u8 重写**：自动重写 m3u8 文件中的 ts 分片 URL，确保视频流完整代理
- ✅ **防盗链绕过**：自动设置正确的 Referer 和 Origin 头

#### 工作原理

**服务器端（搜索/详情）：**
1. 服务器先尝试直接访问资源站 API
2. 如果直连失败或延迟过高，自动通过 CORS 代理重试
3. 成功后会"记住"该站点需要代理，后续请求直接使用代理

**用户端（播放）：**
1. 用户端测速时，先尝试直接访问视频流
2. 如果直连失败或延迟 >1500ms，自动通过 CORS 代理重试
3. 代理会重写 m3u8 内容，将 ts 分片 URL 也改为代理 URL
4. UI 上会显示三种状态：
   - 🟢 **直连**：用户端可直接访问
   - 🟡 **中转**：通过代理访问
   - 🔵 **服务**：服务器端测速（无法客户端测试）

#### 部署 CORS 代理 (Cloudflare Workers)

> ⚠️ **关于流量限制的风险提示**：
> Cloudflare 免费版 Workers 每日有请求限制 (10万次)，且根据条款**不建议**用于大规模非 HTML 内容（如视频流）的代理。
> - **个人自用**：通常没问题。
> - **多人/高频使用**：强烈建议使用下方的 **VPS / Node.js** 部署方案，以免被封号。

1.  **登录 [Cloudflare Dashboard](https://dash.cloudflare.com)**
    - 进入 **Workers & Pages** → **Create Worker**
    - 命名如 `cors-proxy`

2.  **部署代理代码**
    - 复制 `cloudflare-cors-proxy.js` 文件**全部内容**到编辑器
    - 点击 **"Save and Deploy"**
    - 记录 Worker URL（如 `https://cors-proxy.your-name.workers.dev`）

3.  **配置 .env**
    ```env
    CORS_PROXY_URL=https://cors-proxy.your-name.workers.dev
    ```

4.  **（可选）绑定自定义域名**
    - Worker 设置 → Triggers → Custom Domains → 添加域名

> ⚠️ **重要**：每次更新 `cloudflare-cors-proxy.js` 文件后，需要重新部署到 Cloudflare！

#### 部署 CORS 代理 (VPS / Node.js)

如果您有自己的服务器，或者流量较大，建议使用此方式。

1.  **准备环境**：确保 VPS 已安装 Node.js (v18+)。
2.  **上传代码**：上传 `proxy-server.js` 到服务器。
3.  **安装依赖 & 运行**：
    ```bash
    # 安装依赖
    npm install express axios cors dotenv
    
    # 启动服务
    PORT=8080 node proxy-server.js
    ```
    *推荐使用 PM2 守护进程：* `pm2 start proxy-server.js --name cors-proxy`

4.  **配置 .env**：
    ```env
    CORS_PROXY_URL=http://your-vps-ip:8080
    ```

#### 代理工作流程图

```
用户请求 m3u8 视频
        ↓
   代理获取 m3u8
        ↓
  重写 ts 分片 URL
   (改为经过代理)
        ↓
  返回修改后的 m3u8
        ↓
播放器请求 ts 分片
   (通过代理,带正确 Referer)
        ↓
    视频正常播放 ✓
```

---

## 🔒 安全配置与远程加载 (高级)

为了保护您的站点或统一管理配置，可以使用以下高级功能：

### 全局访问密码
在 `.env` 文件中设置 `ACCESS_PASSWORD` 即可开启全局密码保护。开启后，用户访问任何页面都需要输入密码。
```env
ACCESS_PASSWORD=your_secure_password
```

### 远程配置文件 (db.json)
如果您有多个站点或希望远程更新配置，可以让服务器读取远程的 `db.json` 文件。
在 `.env` 文件中设置：
```env
# 远程 JSON 文件地址 (需支持 GET 请求)
REMOTE_DB_URL=https://example.com/my-config/db.json
```
> **注意**：
> 1. 配置 `REMOTE_DB_URL` 后，系统会自动优先尝试从该 URL 获取配置。
> 2. 会有 5 分钟的内存缓存，避免频繁请求远程服务器。
> 3. 如果远程获取失败，会自动降级使用本地的 `db.json` 文件。

### 多用户模式与观看历史同步 (新功能)

支持多个密码，每个密码代表一个独立用户，拥有独立的观看历史。历史记录可在同一用户的不同设备间自动同步。

**配置方式**：在 `.env` 文件中用逗号分隔多个密码：
```env
# 多密码模式
ACCESS_PASSWORD=admin_password,user1_pass,user2_pass
```

**规则说明**：
| 密码位置 | 行为 |
|---------|------|
| **第一个密码** | 保持传统模式，观看历史仅存储在本地设备 |
| **第二个及之后** | 启用云同步，观看历史在设备间自动同步 |

**同步特性**：
- ✅ 自动同步：页面加载时自动拉取和推送历史
- ✅ 本地优先：本地记录不会被其他设备覆盖
- ✅ 智能合并：同一影片以最新的观看记录为准
- ✅ 隐蔽提示：同步状态图标显示在"继续观看"旁边

> ⚠️ **重要**：观看历史同步功能**仅在 SQLite 缓存模式下可用**。
> 
> | 缓存类型 | 历史同步 | 说明 |
> |---------|---------|------|
> | `sqlite` | ✅ 支持 | 推荐，数据持久化存储在数据库中 |
> | `json` | ❌ 不支持 | 仅支持搜索/详情缓存，无用户数据存储 |
> | `memory` | ❌ 不支持 | 服务器重启后数据丢失 |
> | `none` | ❌ 不支持 | 无缓存功能 |
>
> 如需使用历史同步，请在 `.env` 中设置 `CACHE_TYPE=sqlite`。

**使用场景示例**：
```bash
# admin_password - 管理员使用，本地存储
# user1_pass - 家人A使用，全设备同步  
# user2_pass - 家人B使用，全设备同步
ACCESS_PASSWORD=admin123,familyA_pass,familyB_pass
```

---

## 🛡️ 广告过滤功能

本项目内置智能广告过滤模块，可自动检测并过滤 M3U8 视频流中的广告分段。

### 工作原理

广告过滤基于以下技术实现：

1. **`#EXT-X-DISCONTINUITY` 标签检测**：
   - 许多资源站使用此标签插入广告分段
   - 系统会识别视频流开头/结尾的短分段组（3-120秒）并过滤

2. **广告域名模式匹配**：
   - 内置国内外主流广告平台域名特征
   - 自动识别并跳过广告 CDN 的分段

3. **HLS.js Loader 拦截**：
   - 在 M3U8 加载阶段直接过滤广告
   - 对用户完全透明，无需手动操作

### 支持的广告平台

| 平台 | 说明 |
|------|------|
| **百度广告** | 百度联盟、百度推广 |
| **腾讯广点通** | 腾讯广告联盟 |
| **阿里妈妈** | 阿里广告、优酷广告 |
| **字节穿山甲** | 巨量引擎、穿山甲 SDK |
| **视频网站广告** | 爱奇艺、芒果 TV 等贴片广告 |
| **国际平台** | Google DoubleClick、AdSense 等 |

### 使用方式

- **默认开启**：广告过滤默认启用
- **播放器设置**：在播放器设置菜单中可开关广告过滤
- **控制台 API**：
  ```javascript
  AdFilter.enable()   // 开启
  AdFilter.disable()  // 关闭
  AdFilter.getStats() // 查看过滤统计
  ```

### 过滤效果

成功过滤后，播放器会显示提示：`🛡️ 已过滤 X 个广告 (Y秒)`

---

## 📺 TV 模式切换

为了让 Android App 用户也能手动切换 TV 模式，页面底部提供了一个隐蔽但美观的切换入口。

### 入口位置

在页面最底部的 footer 区域，有一个带电视图标的小按钮：

```
┌────────────────────────────────────────┐
│             页面内容...                 │
├────────────────────────────────────────┤
│           [ 📺 TV ]  ← 点击切换        │
│   Data provided by TMDb & Maccms APIs  │
└────────────────────────────────────────┘
```

### 使用方式

| 操作 | 效果 |
|------|------|
| 点击按钮（未激活） | 开启 TV 模式，页面刷新 |
| 点击按钮（已激活） | 关闭 TV 模式，页面刷新 |
| URL 参数 `?tv=1` | 手动开启 TV 模式 |
| URL 参数 `?tv=0` | 手动关闭 TV 模式 |

### TV 模式特性

开启 TV 模式后：
- ✅ 支持遥控器方向键导航
- ✅ 焦点高亮显示
- ✅ 确认键/回车键选择
- ✅ 返回键退出播放器/弹窗

### 自动检测

系统会自动检测以下智能 TV 浏览器并开启 TV 模式：
- Android TV / Google TV
- Amazon Fire TV
- Samsung Tizen TV
- LG WebOS TV
- Roku
- Chromecast with Google TV

---

## 🎛️ 偏好设置

页面底部提供了一个偏好设置入口，允许用户自定义浏览体验。

### 入口位置

在页面最底部的 footer 区域，有一个带齿轮图标的"偏好设置"按钮：

```
┌────────────────────────────────────────┐
│             页面内容...                 │
├────────────────────────────────────────┤
│           [ 📺 TV ]                    │
│         [ ⚙️ 偏好设置 ]  ← 点击打开    │
│   Data provided by TMDb & Maccms APIs  │
└────────────────────────────────────────┘
```

### 可配置选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| **隐藏随机盲盒** | 关闭首页的"随机盲盒·惊喜呈现"推荐板块 | 关闭 |
| **过滤成人内容** | 过滤随机盲盒中的不适宜内容（成人、恐怖类型） | **开启** |

### 功能说明

#### 隐藏随机盲盒
- 开启后，首页将不显示"随机盲盒·惊喜呈现"板块
- 适合不喜欢随机推荐或希望页面更简洁的用户

#### 过滤成人内容
- 开启后，随机盲盒将：
  - 添加 `include_adult=false` 参数过滤 TMDB 的成人标记内容
  - **添加 MPAA 分级过滤**：电影只显示 PG-13 及以下 (排除 R、NC-17 级情色内容如《五十度灰》)
  - **添加 TV 分级过滤**：电视剧只显示 TV-14 及以下 (排除 TV-MA 级成人内容)
- 默认开启，适合家庭环境使用
- 关闭后可看到更多类型的随机推荐（包括 R 级内容）

### 存储机制

- 设置自动保存到浏览器的 `localStorage`
- 跨会话保持，刷新页面后依然生效
- 不同设备/浏览器的设置相互独立

---

## 📦 安装与运行 (Installation)

### 🚀 一键安装脚本 (推荐)

适用于 Ubuntu/Debian/CentOS 系统，自动安装所有依赖并配置服务。

```bash
# 下载并运行一键安装脚本
curl -fsSL https://raw.githubusercontent.com/ednovas/dongguaTV/main/install.sh | bash
```

或者手动下载后运行：
```bash
wget https://raw.githubusercontent.com/ednovas/dongguaTV/main/install.sh
chmod +x install.sh
./install.sh
```

脚本会引导您输入：
- TMDB API Key (必填)
- TMDB 反代地址 (可选，大陆用户需要)
- 运行端口 (默认 3000)
- 运行端口 (默认 3000)
- 安装目录 (默认 /opt/dongguaTV)

> **提示**：安装完成后，您可以随时编辑安装目录下的 `.env` 文件，修改 `CACHE_TYPE` 来切换缓存模式（需要重启服务）。

### 手动本地运行

#### 1. 安装 Node.js (v18+)

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS/RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

**macOS (使用 Homebrew):**
```bash
brew install node@18
```

**Windows:**
下载安装包：https://nodejs.org/

验证安装：
```bash
node -v  # 应显示 v18.x.x
npm -v   # 应显示 9.x.x 或更高
```

#### 2. 安装编译工具 (可选)
如果您计划使用 `sqlite` 作为缓存（默认推荐），则必须安装编译工具。如果不使用 SQLite (如使用 `json` 或 `memory` 模式)，可跳过此步。

**Ubuntu/Debian:**
```bash
sudo apt-get install -y build-essential python3
```

**CentOS/RHEL:**
```bash
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3
```

**macOS:**
```bash
xcode-select --install
```

#### 3. 安装项目依赖
```bash
npm install
```

#### 4. 配置环境变量
复制 `.env.example` 为 `.env`，并配置如下信息：
```env
# TMDb API Key (必填)
TMDB_API_KEY=your_api_key_here

# 可选：自定义端口 (默认 3000)
PORT=3000

# 可选：大陆用户 TMDB 反代地址 (详见下方说明)
TMDB_PROXY_URL=

# 可选：缓存类型 ('json', 'sqlite', 'memory', 'none') - 默认 json
CACHE_TYPE=json

# 可选：访问密码 (设置后需要密码才能访问)
ACCESS_PASSWORD=

# 可选：远程配置文件地址
REMOTE_DB_URL=
```

#### 5. 启动服务
```bash
node server.js
```

#### 6. 访问
打开浏览器访问 `http://localhost:3000`

---

## 🚀 部署 (Deployment)

### 🐳 Docker 部署 (推荐)

#### 环境变量说明

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `TMDB_API_KEY` | ✅ 是 | TMDb API 密钥，用于获取影视信息 |
| `CACHE_TYPE` | ❌ 否 | 缓存类型: `json`(默认), `sqlite`, `memory`, `none` |
| `TMDB_PROXY_URL` | ❌ 否 | TMDB 反代地址，大陆用户需要配置 |
| `CORS_PROXY_URL` | ❌ 否 | 视频/图片 CORS 代理地址，解决资源站播放失败问题 |
| `PORT` | ❌ 否 | 服务端口，默认 3000 |
| `ACCESS_PASSWORD` | ❌ 否 | 访问密码，保护站点不被公开访问 |
| `REMOTE_DB_URL` | ❌ 否 | 远程 `db.json` 地址，用于统一配置管理 |

#### 方案一：使用现有镜像（最快）
无需构建，一行命令直接运行。

> **🎉 多架构支持**：Docker 镜像已支持以下架构，会自动选择匹配的版本：
> - `linux/amd64` - x86_64 服务器、PC
> - `linux/arm64` - Apple M1/M2/M3、树莓派4/5、AWS Graviton
> - `linux/arm/v7` - 树莓派3、旧版 ARM 设备

```bash
# 基础启动 (请替换 TMDB_API_KEY)
docker run -d -p 3000:3000 \
  -e TMDB_API_KEY="your_api_key_here" \
  -e ACCESS_PASSWORD="your_password" \
  --name donggua-tv \
  --restart unless-stopped \
  ghcr.io/ednovas/dongguatv:latest
```

```bash
# 1. ⚠️ 重要：先创建文件，防止 Docker 将其识别为目录
touch db.json cache.db
# 如果是 Windows PowerShell:
# New-Item -ItemType File -Name db.json -Force
# New-Item -ItemType File -Name cache.db -Force

# 2. 写入默认配置 (可选，如果不写则为空)
echo '{"sites":[]}' > db.json
mkdir -p cache/images

# 3. 完整配置启动
docker run -d -p 3000:3000 \
  -e TMDB_API_KEY="your_api_key_here" \
  -e ACCESS_PASSWORD="your_password" \
  -e TMDB_PROXY_URL="https://tmdb-proxy.your-name.workers.dev" \
  -e CORS_PROXY_URL="https://cors-proxy.your-name.workers.dev" \
  -e REMOTE_DB_URL="https://example.com/db.json" \
  -v $(pwd)/db.json:/app/db.json \
  -v $(pwd)/cache.db:/app/cache.db \
  -v $(pwd)/cache/images:/app/public/cache/images \
  --name donggua-tv \
  --restart unless-stopped \
  ghcr.io/ednovas/dongguatv:latest
```

> **⚠️ 常见错误警告**：如果启动失败且日志报错 `EISDIR: illegal operation on a directory`，说明您没有先创建 `db.json` 文件，Docker 自动创建了同名文件夹。请删除该文件夹 (`rm -rf db.json`) 并重新执行上述 `touch` 命令创建文件。
>
> **注意**：如果不挂载 `-v` 卷，您的站点配置(db.json)和缓存(cache.db)将在容器重启后丢失。请确保当前目录下有 `db.json` 文件（如果没有，第一次运行后可以从容器内复制出来）。

#### 方案二：本地构建
如果您想自己修改代码或重新构建镜像：

1.  **构建镜像**
    ```bash
    docker build -t donggua-tv .
    ```
2.  **运行容器**
    ```bash
    docker run -d -p 3000:3000 \
      -e TMDB_API_KEY="your_api_key_here" \
      -e TMDB_PROXY_URL="https://tmdb-proxy.your-name.workers.dev" \
      -e CORS_PROXY_URL="https://cors-proxy.your-name.workers.dev" \
      -e REMOTE_DB_URL="https://example.com/db.json" \
      --name donggua-tv \
      --restart unless-stopped \
      donggua-tv
    ```

#### 方案三：Docker Compose
如果您更喜欢使用 Compose 管理：

1.  创建 `docker-compose.yml` 文件：
    ```yaml
    version: '3'
    services:
      donggua-tv:
        image: ghcr.io/ednovas/dongguatv:latest
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
    
2.  **启动**
    ```bash
    # 同样需要先创建文件，防止挂载成目录
    touch db.json cache.db
    
    # 启动服务
    docker-compose up -d
    ```

### ▲ Vercel 部署
适合零成本快速上线。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV&env=TMDB_API_KEY,REMOTE_DB_URL,ACCESS_PASSWORD,TMDB_PROXY_URL&envDescription=TMDB_API_KEY%20and%20REMOTE_DB_URL%20are%20required.%20Others%20are%20optional.&envLink=https%3A%2F%2Fgithub.com%2Fednovas%2FdongguaTV%23-vercel-%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F%E9%85%8D%E7%BD%AE%E6%B3%A8%E6%84%8F%E4%BA%8B%E9%A1%B9)

*(请确保先将本项目fork到您自己的 GitHub 仓库，点击上方按钮即可一键导入部署)*

#### ⚠️ Vercel 环境变量配置注意事项

在 Vercel 部署后，**必须正确配置环境变量**才能使用：

1. **Settings → Environment Variables** 中添加以下变量：
   - `TMDB_API_KEY` - TMDb API 密钥（**必填**）
   - `REMOTE_DB_URL` - 远程站点配置 JSON 地址（二选一）
   - `SITES_JSON` - 直接嵌入站点配置 JSON（二选一，推荐！避免远程拉取问题）
   - `ACCESS_PASSWORD` - 访问密码（可选）
   - `TMDB_PROXY_URL` - 大陆用户反代地址（可选）

   > **💡 SITES_JSON 使用方法**（推荐）：
   > 
   > 如果 `REMOTE_DB_URL` 无法正常工作，可以直接将 db.json 内容或 Base64 编码后填入 `SITES_JSON`：
   > 
   > **方式一：直接 JSON（适合站点少的情况）**
   > ```
   > SITES_JSON={"sites":[{"key":"ffzy","name":"非凡影视","api":"https://api.ffzyapi.com/api.php/provide/vod/"}]}
   > ```
   > 
   > **方式二：Base64 编码（推荐，避免 JSON 特殊字符问题）**
   > 1. 在线工具 [base64encode.org](https://www.base64encode.org) 将 db.json 内容编码
   > 2. 将编码后的字符串填入 `SITES_JSON`

2. **环境变量不生效？** 请按以下步骤排查：

   | 步骤 | 操作 | 说明 |
   |------|------|------|
   | ① | 检查变量名 | 确保**完全正确**且区分大小写 |
   | ② | 检查环境范围 | 确保勾选了 **Production** 环境 |
   | ③ | **重新部署** | ⚠️ 添加/修改变量后必须重新部署！进入 Deployments → 点击最新部署的 `...` → **Redeploy** |
   | ④ | 使用诊断端点 | 访问 `/api/debug` 查看环境变量状态 |

3. **诊断端点** - 检查配置是否生效：
   
   访问 `https://your-domain.vercel.app/api/debug`，您会看到类似以下的返回：
   ```json
   {
     "environment": "Vercel Serverless",
     "node_version": "v18.x.x",
     "env_status": {
       "TMDB_API_KEY": "configured",      // 应显示 "configured"
       "TMDB_PROXY_URL": "not_set",
       "ACCESS_PASSWORD": "1 password(s)",
       "REMOTE_DB_URL": "not_set",
       "CACHE_TYPE": "memory"
     },
     "cache_type": "memory",
     "timestamp": "2024-01-01T00:00:00.000Z"
   }
   ```
   
   如果 `TMDB_API_KEY` 显示 `"missing"`，说明环境变量未正确配置或未重新部署。

4. **常见问题**：
   - ❌ **修改环境变量后没有重新部署** - 这是最常见的问题！
   - ❌ **环境变量只勾选了 Preview 没勾选 Production**
   - ❌ **使用了错误的变量名**（如 `tmdb_api_key` 而非 `TMDB_API_KEY`）

5. **Vercel 功能限制**：
   由于 Vercel Serverless 无法写入文件系统，以下功能在 Vercel 上不可用：
   - ❌ 本地图片缓存（会自动禁用）
   - ❌ SQLite 缓存（使用内存缓存替代）
   - ❌ 本地 db.json（必须配置 `REMOTE_DB_URL`）
   - ❌ 多用户历史同步（需要持久化存储）


### 🖥️ Linux 服务器命令行部署 (PM2)
适合常规 VPS (Ubuntu/CentOS/Debian)。

1.  **环境准备**
    ```bash
    # 安装 Node.js (v18+)
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
    
    # 安装 PM2 进程管理器
    npm install -g pm2
    ```

2.  **获取代码与运行**
    ```bash
    git clone https://github.com/ednovas/dongguaTV.git
    cd dongguaTV
    npm install
    
    # 配置环境变量
    cp .env.example .env
    # 编辑 .env文件填入您的 TMDB_API_KEY
    nano .env
    
    # 使用 PM2 启动服务
    pm2 start server.js --name "donggua-tv"
    
    # 设置开机自启
    pm2 save && pm2 startup
    ```

### 🏰 宝塔面板 (aaPanel) 部署
可视化管理，不需要懂代码。

1.  在 **软件商店** 搜索并安装 **Node.js版本管理器** (建议选择 v18+)。
2.  **⚠️ 重要：安装编译工具** (better-sqlite3 需要)：
    *   登录 SSH 终端。
    *   执行安装命令：
        ```bash
        # CentOS/RedHat
        sudo yum groupinstall "Development Tools" -y
        sudo yum install python3 -y

        # Ubuntu/Debian
        sudo apt-get install build-essential python3 -y
        ```
3.  在 **网站** -> **Node项目** -> **添加Node项目**。
    *   **项目目录**：选择上传代码的文件夹 (例如 `/www/wwwroot/dongguaTV`)。
    *   **启动选项**：`server.js`。
    *   **项目端口**：`3000`。
3.  **配置环境变量**：
    *   在 **文件** 栏目进入项目目录。
    *   将 `.env.example` 重命名为 `.env`。
    *   编辑 `.env` 文件，配置以下内容：
    ```env
    # 必填：TMDb API Key
    TMDB_API_KEY=your_api_key_here
    
    # 可选：运行端口
    PORT=3000

    # 可选：缓存类型 ('json', 'sqlite', 'memory', 'none')
    CACHE_TYPE=json
    
    # 可选：大陆用户 TMDB 反代地址
    # 如果您的服务器在大陆，请参考"大陆用户配置"章节部署反代
    TMDB_PROXY_URL=https://tmdb-proxy.your-name.workers.dev
    ```
    *   保存后回到 **Node项目** 列表，点击 **重启** 服务。
4.  点击 **映射/绑定域名**，输入您的域名 (如 `movie.example.com`)。
5.  访问域名即可使用。

#### 🤖 Android APP 构建 (GitHub Actions)

本项目配置了自动化构建流程。由于构建 APK 耗时较长，**默认仅在推送 Tag 时触发构建**，普通代码提交不会触发。

1.  **Fork 本仓库** 到您的 GitHub 账号。
2.  **提交 Tag (触发构建)**：
    每当您推送一个以 `v` 开头的 Tag (例如 `v1.0.0`) 到仓库时，GitHub Actions 会自动触发构建。
    ```bash
    git tag v1.0.0
    git push origin v1.0.0
    ```
3.  **下载 APK**：
    构建完成后，在 GitHub 仓库的 **"Releases"** 页面即可下载生成的 `.apk` 安装包。
    *此 APK 包含沉浸式状态栏支持及自动优化的应用图标。*

#### 📱 构建特性
- **自动图标优化**：GitHub Actions 会自动调整图标尺寸并添加安全边距，防止在圆形图标遮罩下被裁剪。
- **沉浸式适配**：内置原生级状态栏适配逻辑，自动处理 Safe Area，确保刘海屏手机无遮挡。

#### 📱 APK 默认配置

| 配置项 | 值 |
|--------|-----|
| **App 名称** | E视界 |
| **默认服务器** | `https://ednovas.video` |
| **图标来源** | 自动从 `public/icon.png` 生成 |

#### 🔧 自定义构建 (新功能)
无需修改代码，直接在 GitHub 网页上自定义并构建 App：

1.  进入仓库的 **Actions** 页面。
2.  在左侧选择 **"Android Build & Release"**。
3.  点击右侧的 **Run workflow** 按钮。
4.  输入配置信息：
    - **Server URL**: 您的服务器地址 (例如 `https://movie.example.com`)
    - **App Name**: App 名称 (例如 `我的私人影院`)
    - **Version Tag**: 版本号 (例如 `v1.0.0`)
5.  点击 **Run workflow** 开始构建。

等待构建完成后，在 Releases 页面即可下载您定制的 App。

#### 🔧 代码修改方式 (高级)

如果您 Fork 了本项目并希望永久修改默认配置：

##### 📱 配置文件位置

| 配置文件路径 | App ID |
|-------------|--------|
| `capacitor.config.json` | `com.ednovas.donguatv` |

只需修改 `server.url` 即可更改内置网站地址：

1.  编辑对应的 `capacitor.config.json`，修改 `server.url` 为您的服务器地址：
    ```json
    {
      "appId": "com.ednovas.donguatv",
      "appName": "E视界",
      "webDir": "public",
      "server": {
        "url": "https://your-server.com",
        "cleartext": true
      }
    }
    ```

2.  提交更改并推送 Tag 触发自动构建：
    ```bash
    git add capacitor.config.json
    git commit -m "修改服务器地址"
    git tag v1.0.0
    git push origin main --tags
    ```

3.  或者本地手动构建：
    ```bash
    npm install
    npx cap sync android
    cd android && ./gradlew assembleRelease
    ```
    APK 位于 `android/app/build/outputs/apk/release/`

#### ⚠️ App 使用问题与替代方案

如果您在使用 Android App 时遇到以下问题：

| 问题类型 | 具体表现 |
|---------|---------|
| **安装问题** | "应用不兼容"、"解析包错误"、无法安装 |
| **运行问题** | 闪退、白屏、卡顿、无法加载 |
| **播放问题** | 视频无法播放、黑屏、没有声音 |
| **界面问题** | 显示异常、遥控器无法操作 |

**👉 强烈建议使用以下替代方案：**

1. **🌐 网页版（推荐）**
   - 直接在设备浏览器中访问您部署的网站地址
   - 兼容性最好，无需安装，随时更新
   - 电视浏览器推荐：当贝浏览器、ES浏览器

2. **📺 投屏播放（推荐）**
   - 在手机/电脑浏览器打开网页版
   - 点击播放页面的「一键投屏」按钮
   - 将视频投送到电视/投影仪播放
   - 支持 DLNA/AirPlay 协议

3. **📱 PWA 模式**
   - 在浏览器中访问网站
   - 点击「添加到主屏幕」
   - 获得类似 App 的使用体验

> 💡 **为什么推荐网页版？**
> - App 受限于 Android 系统版本、WebView 内核版本、设备兼容性等因素
> - 网页版始终使用最新代码，无需手动更新
> - 投屏功能让您可以在大屏幕上观看，同时用手机控制


---


## 💾 数据维护与备份

本项目的核心数据存储在以下两个文件中，建议定期备份：

1.  **`db.json`**：存储所有的采集源配置信息（重要）。
2.  **`cache.db`** (SQLite模式)：存储搜索结果和详情的数据库文件。
3.  **`cache_search.json` / `cache_detail.json`** (JSON模式)：存储缓存的 JSON 文件。

### 备份命令示例
```bash
# 备份到当前用户的 backup 目录
mkdir -p ~/backup
cp /opt/dongguaTV/db.json ~/backup/
# 如果使用 SQLite
[ -f /opt/dongguaTV/cache.db ] && cp /opt/dongguaTV/cache.db ~/backup/
# 如果使用 JSON
[ -f /opt/dongguaTV/cache_search.json ] && cp /opt/dongguaTV/cache_search.json ~/backup/
```

### 清理缓存
```bash
# SQLite 模式
rm /opt/dongguaTV/cache.db

# JSON 模式
rm /opt/dongguaTV/cache_*.json

# 重启服务生效
pm2 restart donggua-tv
```

---

## 📝 贡献与致谢

本项目由 **kk爱吃王哥呆阿龟头** 设计编写， **ednovas** 优化了功能和部署流程。
数据由 **TMDb** 和各式 **Maccms** API 提供。

---

## ⚠️ 免责声明 (Disclaimer)

1.  **仅供学习交流**：本项目仅作为 Node.js 和 Vue 3 的学习练手项目开源，旨在展示前后端交互、数据聚合与 UI 设计技术。
2.  **API 说明**：本项目**不内置**任何有效的影视资源采集接口。README 或代码演示中可能出现的 API 地址仅为占位符或示例，不保证可用性。
3.  **自行配置**：使用者需自行寻找合法的 Maccms V10/JSON 格式的采集接口，并遵守相关法律法规。
4.  **内容无关**：开发者不存储、不发布、不参与任何视频内容的制作与传播，对用户配置的内容不承担任何责任。

---

*Enjoy your movie night! 🍿*
