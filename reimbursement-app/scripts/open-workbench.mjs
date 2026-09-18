import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { frontendIdentity } from './frontend-server.mjs';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localURL = 'http://127.0.0.1:4317/';

export async function probeFrontend(url = localURL) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(1500) });
    return response.status === 200 && response.headers.get('x-reimbursement-frontend') === frontendIdentity ? 'ready' : 'occupied';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'absent' : 'occupied'; }
}

export async function startFrontend() {
  const status = await probeFrontend();
  if (status === 'ready') return localURL;
  if (status === 'occupied') throw new Error('端口 4317 已被其他服务或旧后端占用；请先关闭该服务，再启动静态前端。');
  if (!fs.existsSync(path.join(appDirectory, 'dist', 'index.html')) || !fs.existsSync(path.join(appDirectory, 'dist', 'frontend-config.json'))) throw new Error('缺少前端构建，请在 reimbursement-app 目录运行 pnpm build。');
  const child = spawn(process.execPath, [path.join(appDirectory, 'scripts', 'frontend-server.mjs')], { cwd: appDirectory, env: { ...process.env, REIMBURSE_FRONTEND_PORT: '4317' }, detached: true, windowsHide: true, stdio: 'ignore' });
  let startupError;
  child.on('error', () => { startupError = new Error('无法启动静态前端进程。'); });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (startupError) throw startupError;
    await new Promise(resolve => setTimeout(resolve, 200));
    const next = await probeFrontend();
    if (next === 'ready') return localURL;
    if (next === 'occupied') throw new Error('端口 4317 未响应为本应用静态前端，请检查端口占用。');
    if (child.exitCode !== null) break;
  }
  throw new Error('静态前端未能启动，请检查构建文件或运行 pnpm start 查看错误。');
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:REIMBURSE_OPEN_URL'], { env: { ...process.env, REIMBURSE_OPEN_URL: url }, windowsHide: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    child.on('error', () => reject(new Error(`请在浏览器中打开 ${url}`)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`请在浏览器中打开 ${url}`)));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await openBrowser(await startFrontend()); }
  catch (error) {
    const message = error instanceof Error ? error.message : '前端启动失败。';
    console.error(message);
    try { fs.writeFileSync(path.join(appDirectory, 'frontend-launch-error.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); } catch {}
    process.exitCode = 1;
  }
}
