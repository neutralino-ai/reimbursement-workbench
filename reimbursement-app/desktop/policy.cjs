'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_ORIGIN = 'reimbursement://app';
const APP_URL = `${APP_ORIGIN}/`;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
});
const blockedDirectories = new Set(['api', 'src', 'server', 'scripts', 'data', 'incoming', 'output', 'node_modules', 'client-private']);

function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'apiBaseUrl')) throw new Error('连接配置只允许 API 地址。');
  if (typeof value.apiBaseUrl !== 'string' || value.apiBaseUrl.length > 2048) throw new Error('API 地址无效。');
  const raw = value.apiBaseUrl.trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('请输入完整的 HTTPS API 地址。'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || raw.includes('?') || raw.includes('#') || raw.includes('\\') || !/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)) throw new Error('API 地址须使用 HTTPS，且不含账号、密码、查询参数或片段。');
  return { apiBaseUrl: url.href.replace(/\/$/, '') };
}

function isAppDocument(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'reimbursement:' && url.host === 'app' && !url.username && !url.password && !url.search && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}

function isAppBlob(value) {
  return typeof value === 'string' && /^blob:reimbursement:\/\/app\/[a-f0-9-]{36}(?:#[^\s]*)?$/i.test(value);
}

function externalHTTPS(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\u0000-\u0020\u007f]/.test(value) ? url.href : null;
  } catch { return null; }
}

function contentSecurityPolicy(connection) {
  const origin = new URL(validateConnection(connection).apiBaseUrl).origin;
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin}; img-src 'self' blob: data:; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

function readBuiltFile(distDir, relative) {
  const root = path.resolve(distDir);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\0:]/.test(part) || blockedDirectories.has(part.toLowerCase()))) throw new Error('路径不允许。');
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(root + path.sep)) throw new Error('路径不允许。');
  let current = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('构建目录不能是符号链接。');
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不提供符号链接。');
  }
  if (!fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(target).isFile()) throw new Error('路径不允许。');
  return fs.readFileSync(target);
}

function bundledConnection(distDir) {
  return validateConnection(JSON.parse(readBuiltFile(distDir, 'frontend-config.json').toString('utf8')));
}

function staticResource(distDir, value, connection) {
  let url;
  try { url = new URL(value); } catch { return { status: 400 }; }
  if (url.protocol !== 'reimbursement:' || url.host !== 'app' || url.username || url.password || url.search) return { status: 403 };
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return { status: 400 }; }
  if (pathname === '/frontend-config.json') return { status: 200, type: 'application/json; charset=utf-8', bytes: Buffer.from(JSON.stringify(validateConnection(connection))) };
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const extension = path.extname(relative).toLowerCase();
  if (!MIME[extension] || (extension === '.html' && relative !== 'index.html')) return { status: 404 };
  try { return { status: 200, type: MIME[extension], bytes: readBuiltFile(distDir, relative) }; }
  catch { return { status: 404 }; }
}

function inspectBundle(appDir, { packaged = false } = {}) {
  const root = path.resolve(appDir);
  const dist = path.join(root, 'dist');
  const connection = bundledConnection(dist);
  const html = readBuiltFile(dist, 'index.html').toString('utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('构建目录缺少 JavaScript 入口。');
  for (const asset of assets) if (staticResource(dist, APP_ORIGIN + asset, connection).status !== 200) throw new Error('构建资源不完整。');
  for (const filename of ['main.cjs', 'preload.cjs', 'policy.cjs']) if (!fs.statSync(path.join(root, 'desktop', filename)).isFile()) throw new Error('桌面运行文件不完整。');
  if (packaged) {
    const allowed = new Set(['desktop', 'dist', 'package.json']);
    if (fs.readdirSync(root).some(name => !allowed.has(name))) throw new Error('安装包包含前端运行目录以外的文件。');
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || blockedDirectories.has(entry.name.toLowerCase())) throw new Error('安装包中存在不允许的目录或链接。');
        if (entry.isDirectory()) visit(path.join(directory, entry.name));
      }
    };
    visit(root);
  }
  return { valid: true, packaged, origin: APP_ORIGIN, apiBaseUrl: connection.apiBaseUrl, assets: assets.length, backendIncluded: false };
}

module.exports = { APP_ORIGIN, APP_URL, validateConnection, isAppDocument, isAppBlob, externalHTTPS, contentSecurityPolicy, readBuiltFile, bundledConnection, staticResource, inspectBundle };
