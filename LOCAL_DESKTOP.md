# DongguaTV Enhanced Desktop

This folder is a local Windows desktop build of EdNovas/dongguaTV.

## Run

```powershell
npm.cmd run desktop
```

Or double-click:

```text
start-desktop.bat
```

The app starts a local Express server and opens an Electron window.

## Runtime Data

Electron stores runtime files under:

```text
%APPDATA%\DongguaTV Enhanced\runtime
```

Important files:

- `.env`: local configuration
- `db.json`: source-site configuration, created from `db.template.json`
- `cache_search.json` / `cache_detail.json`: JSON cache when `CACHE_TYPE=json`
- `cache\`: image cache

## Configure

Edit the generated `.env` file to set:

```env
TMDB_API_KEY=
ACCESS_PASSWORD=
TMDB_PROXY_URL=
CORS_PROXY_URL=
REMOTE_DB_URL=
CACHE_TYPE=json
```

This desktop wrapper defaults to JSON cache because `better-sqlite3` is a native
module and needs extra Electron rebuild work when SQLite is enabled.
