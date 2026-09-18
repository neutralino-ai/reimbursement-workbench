'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require('electron');
const { APP_URL, validateConnection, isAppDocument, isAppBlob, externalHTTPS, contentSecurityPolicy, bundledConnection, staticResource, inspectBundle } = require('./policy.cjs');
const {checkForUpdates} = require('./updates.cjs');

app.setName('报销工作台');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'reimbursement', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist');
let mainWindow;
let connection;
let desktopSession;
let checkedUpdate;
let checkingUpdate;
const clientVersion = require('../package.json').version;

// This check does not create a window, inspect private data or contact the API.
if (process.argv.includes('--verify-package')) {
  try {
    const result = inspectBundle(appDir, { packaged: app.isPackaged });
    process.stdout.write(JSON.stringify(result) + '\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(JSON.stringify({ valid: false, error: error.message }) + '\n');
    app.exit(1);
  }
} else {
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', () => {
      if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    });
    app.whenReady().then(start).catch(error => {
      dialog.showErrorBox('无法启动报销工作台', error.message);
      app.quit();
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    app.on('activate', () => { if (desktopSession && !mainWindow) createWindow(); });
  }
}

function settingsFile() { return path.join(app.getPath('userData'), 'connection.json'); }

function readConnection() {
  const fallback = bundledConnection(distDir);
  try { return validateConnection(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') dialog.showErrorBox('连接设置无效', '已恢复安装包中的 API 地址。请在连接设置中重新保存地址。');
    return fallback;
  }
}

function saveConnection(value) {
  const next = validateConnection(value);
  const filename = settingsFile();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filename);
  connection = next;
  return { ...next };
}

function verifySender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame || !isAppDocument(event.senderFrame.url)) throw new Error('只允许本地工作台修改连接设置。');
}

const securePreferences = {
  contextIsolation: true, sandbox: true, nodeIntegration: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  navigateOnDragDrop: false, spellcheck: false,
};

async function start() {
  inspectBundle(appDir, { packaged: app.isPackaged });
  connection = readConnection();
  // No persist: prefix: browser cache, cookies and authentication stay in memory.
  desktopSession = session.fromPartition('reimbursement-desktop', { cache: false });
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.protocol.handle('reimbursement', request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const resource = staticResource(distDir, request.url, connection);
    return new Response(request.method === 'HEAD' ? null : resource.bytes || 'Not found', {
      status: resource.status,
      headers: {
        'Content-Type': resource.type || 'text/plain; charset=utf-8',
        'Content-Security-Policy': contentSecurityPolicy(connection),
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      },
    });
  });
  desktopSession.on('will-download', (event, item) => {
    // AuthenticatedFiles obtains the bytes in the renderer; main never fetches attachments.
    if (!isAppBlob(item.getURL())) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '保存报销材料' });
  });
  ipcMain.handle('reimbursement:connection:get', event => { verifySender(event); return { ...connection }; });
  ipcMain.handle('reimbursement:connection:save', (event, value) => { verifySender(event); return saveConnection(value); });
  ipcMain.handle('reimbursement:updates:version', event => {verifySender(event);return clientVersion;});
  ipcMain.handle('reimbursement:updates:check', async event => {
    verifySender(event);
    if(!checkingUpdate)checkingUpdate=checkForUpdates({currentVersion:clientVersion}).then(result=>{checkedUpdate=result;return result;}).finally(()=>{checkingUpdate=null;});
    return checkingUpdate;
  });
  ipcMain.handle('reimbursement:updates:open', async event => {
    verifySender(event);
    if(!checkedUpdate||checkedUpdate.status!=='available')throw new Error('请先检查是否有新版本');
    await shell.openExternal(checkedUpdate.downloadUrl||checkedUpdate.releaseUrl);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  createWindow();
}

function openExternal(value) {
  const target = externalHTTPS(value);
  if (target) void shell.openExternal(target).catch(() => {});
}

function guardWindow(window, { preview = false } = {}) {
  const contents = window.webContents;
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, target) => {
    if (preview ? isAppBlob(target) || target === 'about:blank' : isAppDocument(target)) return;
    event.preventDefault();
    if (!preview) openExternal(target);
  });
  contents.on('will-redirect', (event, target) => {
    if (!(preview ? isAppBlob(target) : isAppDocument(target))) event.preventDefault();
  });
  contents.setWindowOpenHandler(details => {
    if (!preview && (details.url === 'about:blank' || isAppBlob(details.url))) return {
      action: 'allow', overrideBrowserWindowOptions: {
        width: 1000, height: 820, title: '报销材料', autoHideMenuBar: true,
        // Enable Chromium's built-in PDF viewer only in attachment windows.
        webPreferences: { ...securePreferences, session: desktopSession, preload: undefined, plugins: true },
      },
    };
    if (!preview) openExternal(details.url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', child => guardWindow(child, { preview: true }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: '报销工作台', width: 1340, height: 900, minWidth: 880, minHeight: 640,
    backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { ...securePreferences, session: desktopSession, preload: path.join(__dirname, 'preload.cjs') },
  });
  guardWindow(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(APP_URL);
}
