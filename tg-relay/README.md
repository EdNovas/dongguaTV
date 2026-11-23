# tg-relay · Telegram 频道视频中转

给成人站用：登录你的 Telegram 账号（可以多个），把指定频道里的视频**按签名地址分段**转给观众（支持拖进度条），封面也由它给。成人站只问它要频道里的帖子列表，自己不连 Telegram、不转视频。

- 视频流量全走这台机器：**放在流量不限的服务器上**。拉过的部分存在本机磁盘（默认上限 20GB，最近最少看的先删），同一段不会重复从 Telegram 拉。
- 只认成人站签过名的地址（地址 48 小时过期）：别人拿不到签名，没法拿它当免费 Telegram 下载器。成人站不收的视频（被过滤拦的、太短的、没正文的）永远拿不到签名，所以中转也不会去下载它们。
- **不要把它放在 Cloudflare 代理后面**（橙色云朵）：CDN 条款不允许大量转视频。DNS 只解析（灰色云朵）就行。

## 1. 申请 api_id / api_hash（一次）

用其中一个 Telegram 账号登录 <https://my.telegram.org> → **API development tools** → 随便填个应用名 → 得到 `api_id`（数字）和 `api_hash`。所有账号共用这一对。

## 2. 装

服务器上要有 Node.js 22 或 24。

```bash
git clone -b adult <你的仓库地址> dongguatv && cd dongguatv/tg-relay
npm install --omit=dev
cp .env.example .env      # 然后编辑 .env
```

`.env` 里要填：

| 变量 | 说明 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | 第 1 步拿到的 |
| `RELAY_SECRET` | 随机长串（≥16 位），成人站的 `ADULT_TG_SECRET` 填同一个。生成：`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `RELAY_PORT` | 默认 8790（前面套 HTTPS 反代时只监听本机：`RELAY_HOST=127.0.0.1`） |
| `RELAY_CACHE_GB` | 视频分块的磁盘缓存上限，默认 20 |
| `RELAY_MAX_STREAMS` | 同时最多转多少个视频流，默认 60（超了回 503，播放器会重试 / 换线路） |
| `RELAY_DATA` | 数据目录，默认 `./data`（账号、缓存都在这里） |

## 3. 登录账号（每个账号一次）

```bash
node login.js
```

按提示输入手机号（带国家码）、Telegram App 里收到的验证码、二步验证密码（没设过就回车）。手机号 / 验证码 / 密码只在你自己的终端里输入，不会发给任何人。登录结果存在 `data/sessions.json`。

- 多个账号就多运行几次，每次起个不同的名字。中转在跑的话 30 秒内自动用上新账号，不用重启。
- `node login.js --list` 看有哪些账号，`node login.js --remove a2` 删掉一个。
- **用小号，别用自己的主号**：大量下载可能被 Telegram 限流甚至封号。账号不用加入频道（公开频道直接能读）。
- 非会员账号下载太快时 Telegram 会限速（`FLOOD_PREMIUM_WAIT`），中转会让这个账号歇一会、换别的账号接着拉；账号越多越顺。会员账号快得多。
- **`data/sessions.json` 等于这些账号的登录凭据**：拿到它的人能直接用这些账号。别外传、别提交到 git（仓库已经忽略 `tg-relay/data/`）。

## 4. 跑起来

```bash
node server.js
```

长期运行用 pm2（`pm2 start server.js --name tg-relay`）或 systemd，宝塔可以建"Node 项目"指向 `server.js`。

前面套 HTTPS（成人站是 https，视频地址必须也是 https），例如 Caddy：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

## 5. 成人站那边

在成人站的 `.env` 里：

```
ADULT_TG_RELAY=https://relay.example.com
ADULT_TG_SECRET=<和 RELAY_SECRET 一样>
ADULT_TG_CHANNELS=TS88158:伪娘,ladyboy_nngy:人妖,ntong_1:女同,TBB18V
```

重启成人站。规则（收不收、整个频道停用）见 `docs/ADULT.md` 的「Telegram 频道当片源」。

## 6. 检查

```bash
curl -H "Authorization: Bearer <RELAY_SECRET>" https://relay.example.com/api/health
```

看 `accounts` 里每个账号是不是 `ok: true`、有没有在限流（`floodSec`），`cache` 是磁盘缓存用量，`fromTg` / `fromCache` 是从 Telegram 拉的 / 从缓存给的字节数。

成人站后台：`GET /api/adult/admin/tg`（带 `X-Admin-Token`）看每个频道同步到第几条、命中未成年几条、有没有被停用。

## 接口

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET/HEAD /v/<频道>/<消息id>?e=&s=` | 签名 | 视频，支持 Range |
| `GET /t/<频道>/<消息id>.jpg?e=&s=` | 签名 | 封面（视频自带的缩略图） |
| `GET /api/list?ch=&after=&limit=&info=1` | `Authorization: Bearer <RELAY_SECRET>` | 频道里 id 大于 `after` 的视频消息（每次最多 100 条消息） |
| `GET /api/msg?ch=&id=` | 同上 | 单条视频消息 |
| `GET /api/health` | 同上 | 账号 / 缓存状态 |
| `GET /healthz` | 无 | 存活检查 |
