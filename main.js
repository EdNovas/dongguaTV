const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { ensureDesktopState } = require('./server/desktop/startupState');

let mainWindow;

app.setName('DongguaTV Enhanced');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');

function findAvailablePort(startPort, maxTries = 40) {
  return new Promise((resolve, reject) => {
    let port = Number(startPort);

    const tryPort = () => {
      const tester = net
        .createServer()
        .once('error', (error) => {
          if (error.code === 'EADDRINUSE' && port < Number(startPort) + maxTries) {
            port += 1;
            tryPort();
            return;
          }
          reject(error);
        })
        .once('listening', () => {
          tester.close(() => resolve(port));
        })
        .listen(port, '127.0.0.1');
    };

    tryPort();
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#050505',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;

    if (input.key === 'Enter') {
      event.preventDefault();
      if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    }

    if (input.key === 'Escape') {
      event.preventDefault();
      if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    }
  });
}

app.whenReady().then(async () => {
  const dataDir = process.env.DONGGUATV_DATA_DIR || path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  ensureDesktopState(dataDir);

  const envPath = path.join(dataDir, '.env');
  if (!fs.existsSync(envPath)) {
    const projectEnvPath = path.join(__dirname, '.env');
    if (fs.existsSync(projectEnvPath)) {
      fs.copyFileSync(projectEnvPath, envPath);
    } else {
      fs.writeFileSync(
        envPath,
        [
          'PORT=3000',
          'TMDB_API_KEY=',
          'ACCESS_PASSWORD=',
          'TMDB_PROXY_URL=',
          'CORS_PROXY_URL=',
          'REMOTE_DB_URL=',
          'CACHE_TYPE=json',
          ''
        ].join('\n'),
        'utf8'
      );
    }
  }

  require('dotenv').config({ path: envPath });

  const port = await findAvailablePort(process.env.PORT || 3000);
  process.env.PORT = String(port);
  process.env.DONGGUATV_DATA_DIR = dataDir;
  process.env.CACHE_TYPE = process.env.CACHE_TYPE || 'json';

  require('./server.js');

  setTimeout(() => createWindow(port), 900);
});

app.on('window-all-closed', () => {
  app.quit();
});
