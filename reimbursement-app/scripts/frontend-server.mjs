import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const frontendIdentity = 'reimbursement-static-v1';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm' };
const blockedDirectories = new Set(['api', 'src', 'server', 'scripts', 'data', 'incoming', 'output', 'node_modules', 'client-private']);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const inside = (root, target) => target.startsWith(root + path.sep);

function readBuiltFile(root, filename) {
  const parts = filename.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\0:]/.test(part))) throw failure('路径不允许。', 403);
  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) throw failure('路径不允许。', 403);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const item = fs.lstatSync(current);
    if (item.isSymbolicLink()) throw failure('不提供符号链接文件。', 403);
  }
  if (!inside(fs.realpathSync(root), fs.realpathSync(target))) throw failure('路径不允许。', 403);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw failure('未找到构建文件。', 404);
  return fs.readFileSync(target);
}

function connectionPolicy(root) {
  let config;
  try { config = JSON.parse(readBuiltFile(root, 'frontend-config.json').toString('utf8')); }
  catch { throw new Error('缺少有效的 dist/frontend-config.json，请先运行 pnpm build。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'apiBaseUrl') || typeof config.apiBaseUrl !== 'string' || !config.apiBaseUrl) throw new Error('前端公开配置仅允许 apiBaseUrl，不得包含凭据。');
  let url;
  try { url = new URL(config.apiBaseUrl); } catch { throw new Error('前端 API 地址无效。'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || config.apiBaseUrl.includes('?') || config.apiBaseUrl.includes('#') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('前端 API 地址须为无凭据的 HTTPS 地址，或本机 HTTP 地址。');
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${url.origin}; img-src 'self' blob: data: ${url.origin}; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

/** Serves build artifacts only: no database, source files, authentication or API proxy. */
export function createFrontendServer({ distDir = path.join(appDirectory, 'dist') } = {}) {
  const root = path.resolve(distDir);
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) throw new Error('缺少 dist 构建目录，请先运行 pnpm build。');
  try { readBuiltFile(root, 'index.html'); } catch { throw new Error('缺少 dist/index.html，请先运行 pnpm build。'); }
  const csp = connectionPolicy(root);
  const server = http.createServer((req, res) => {
    res.setHeader('X-Reimbursement-Frontend', frontendIdentity);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    const reply = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : text); };
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 4317;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return reply(403, '仅允许本机访问。');
    if (!['GET', 'HEAD'].includes(req.method)) return reply(405, '静态前端只接受 GET 或 HEAD。');
    try {
      if (!req.url?.startsWith('/')) return reply(400, '请求地址无效。');
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) return reply(403, '路径不允许。');
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const parts = relative.split('/');
      const extension = path.extname(relative).toLowerCase();
      if (parts.some(part => part.startsWith('.') || blockedDirectories.has(part.toLowerCase())) || !mime[extension] || (extension === '.json' && relative !== 'frontend-config.json') || (extension === '.html' && relative !== 'index.html')) return reply(404, '仅提供前端构建文件；API 请连接配置的服务器。');
      const bytes = readBuiltFile(root, relative);
      res.writeHead(200, { 'Content-Type': mime[extension], 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof URIError) return reply(400, '请求地址编码无效。');
      const status = error.statusCode || (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500);
      return reply(status, status === 403 ? '路径不允许。' : status === 404 ? '未找到前端构建文件。' : '无法读取前端构建文件。');
    }
  });
  return { server, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.REIMBURSE_FRONTEND_PORT || 4317);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('REIMBURSE_FRONTEND_PORT 须在 1024 到 65535 之间。');
    const app = createFrontendServer();
    app.server.listen(port, '127.0.0.1', () => console.log(`报销工作台静态前端：http://127.0.0.1:${port}/`));
    app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请检查是否仍在运行旧后端。` : '静态前端无法启动。'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
