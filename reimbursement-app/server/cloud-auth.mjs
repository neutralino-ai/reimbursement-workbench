import { randomBytes, createHash, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { constants, mkdirSync, lstatSync, openSync, fstatSync, fchmodSync, chmodSync, closeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = '__Secure-ReimbursementSession';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const fail = (message, statusCode, extra = {}) => { throw Object.assign(new Error(message), { statusCode, ...extra }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const isSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function settings({ dataDir, publicOrigin, basePath = '/reimbursement', now = Date.now, trustLoopbackProxy = false, frontendUrl }) {
  if (typeof dataDir !== 'string' || !dataDir) fail('必须指定登录数据目录。', 500);
  let origin;
  try { origin = new URL(publicOrigin); } catch { fail('云端登录需要有效的 HTTPS publicOrigin。', 500); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.href.includes('?') || origin.href.includes('#')) fail('云端登录需要不含路径、账户或参数的 HTTPS publicOrigin。', 500);
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/.test(basePath)) fail('登录 basePath 无效。', 500);
  if (typeof now !== 'function') fail('登录时钟无效。', 500);
  if (typeof trustLoopbackProxy !== 'boolean') fail('trustLoopbackProxy 必须为明确的布尔值。', 500);
  let frontend;
  if (frontendUrl !== undefined) {
    if (typeof frontendUrl !== 'string' || frontendUrl.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(frontendUrl) || !/^https?:\/\//.test(frontendUrl)) fail('frontendUrl 必须为 HTTPS 或本机 HTTP 页面地址。', 500);
    try { frontend = new URL(frontendUrl); } catch { fail('frontendUrl 无效。', 500); }
    const host = frontend.hostname.replace(/^\[|\]$/g, '');
    const local = host.toLowerCase() === 'localhost' || isLoopbackIP(canonicalIP(host));
    if ((frontend.protocol !== 'https:' && !(frontend.protocol === 'http:' && local)) || frontend.username || frontend.password || frontend.href.includes('?') || frontend.href.includes('#')) fail('frontendUrl 仅允许 HTTPS 或本机 HTTP，且不能含账户、查询参数或片段。', 500);
  }
  return { dataDir: path.resolve(dataDir), publicOrigin: origin.origin, basePath: basePath.replace(/\/$/, ''), now, trustLoopbackProxy, frontendUrl: frontend ? frontend.href.replace(/\/?$/, '/') : null };
}

function canonicalIP(value) {
  if (typeof value !== 'string' || value.length > 64 || value.includes('%')) return null;
  const input = value.trim();
  const family = isIP(input);
  if (family === 4) return input;
  if (family === 6) {
    const normalized = new URL(`http://[${input}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
    return normalized;
  }
  return null;
}

function isLoopbackIP(address) { return address === '::1' || (isIP(address || '') === 4 && address.startsWith('127.')); }

function clientAddress(req, trustLoopbackProxy) {
  const peer = canonicalIP(req?.socket?.remoteAddress);
  const loopback = isLoopbackIP(peer);
  if (trustLoopbackProxy && loopback) {
    const forwarded = canonicalIP(req?.headers?.['x-real-ip']);
    if (forwarded) return forwarded;
  }
  return peer || 'unknown';
}

function ensureRegularPrivateFile(filename) {
  try { if (lstatSync(filename).isSymbolicLink()) fail('登录配置不能使用符号链接。', 500); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('登录配置须为独立的普通文件。', 500);
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

function openAuthStore(dataDir) {
  const directory = path.join(dataDir, 'auth');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail('登录配置目录不能使用符号链接。', 500);
  chmodSync(directory, 0o700);
  const filename = path.join(directory, 'cloud-auth.sqlite');
  ensureRegularPrivateFile(filename);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { if (lstatSync(filename + suffix).isSymbolicLink()) fail('登录配置辅助文件不能使用符号链接。', 500); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS auth_config (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_tokens (id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
  } catch (error) { db.close(); throw error; }
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function passwordValid(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || Buffer.byteLength(password) > 512) return false;
  const length = Array.from(password).length;
  return length >= 12 && length <= 128;
}

function sessionToken(req) {
  const authorization = req?.headers?.authorization;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') return null;
    const match = /^(\S+) ([a-f0-9]{64})$/.exec(authorization);
    // An explicit header never falls back to ambient cookies. Bearer belongs to the Agent API.
    return match && match[1].toLowerCase() === 'session' ? match[2] : null;
  }
  const raw = req?.headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const values = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE_NAME.length + 1);
  return isSecret(value) ? value : null;
}

/** Dedicated cloud mode only. Local workbench mode must not construct this service. */
export function createCloudAuth(options) {
  const config = settings(options);
  const db = openAuthStore(config.dataDir);
  const buckets = new Map();
  let queue = Promise.resolve();
  let queued = 0;
  let closed = false;
  const at = () => {
    const value = config.now();
    if (!Number.isSafeInteger(value) || value < 0) fail('登录时钟无效。', 500);
    return value;
  };
  const readConfig = () => db.prepare('SELECT * FROM auth_config WHERE id=1').get();
  function consume(keys) {
    const timestamp = at();
    for (const [key, item] of buckets) if (item.until <= timestamp) buckets.delete(key);
    for (const [key, limit] of keys) {
      const item = buckets.get(key);
      if (item && item.count >= limit) fail('尝试过于频繁，请稍后再试。', 429, { retryAfter: Math.max(1, Math.ceil((item.until - timestamp) / 1000)) });
    }
    for (const [key] of keys) {
      const item = buckets.get(key) || { count: 0, until: timestamp + RATE_WINDOW_MS };
      item.count += 1;
      buckets.set(key, item);
    }
  }
  async function derive(password, salt) {
    if (queued >= 4) fail('登录服务繁忙，请稍后再试。', 429, { retryAfter: 5 });
    queued++;
    const result = queue.then(() => scrypt(password, Buffer.from(salt, 'hex'), 64, SCRYPT));
    queue = result.catch(() => {});
    try { return await result; } finally { queued--; }
  }
  function cookie(token, expiresAt) {
    return `${COOKIE_NAME}=${token}; Path=${config.basePath}/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(SESSION_MS / 1000) : 0}; Expires=${new Date(expiresAt).toUTCString()}`;
  }
  return {
    status(req) {
      const configured = !!readConfig();
      const token = sessionToken(req);
      const session = token && configured ? db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(hash(token)) : null;
      return { enabled: true, configured, authenticated: !!session && session.expires_at > at() };
    },
    async setup(input) {
      if (readConfig()) fail('登录密码已设置，初始化链接不能再次使用。', 409);
      consume([['setup', 8], ['global', 30]]);
      const token = input?.token;
      const password = input?.password;
      const issued = db.prepare('SELECT * FROM setup_tokens WHERE id=1').get();
      if (!isSecret(token) || !issued || issued.expires_at <= at() || !isSecret(issued.token_hash) || !timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(issued.token_hash, 'hex'))) fail('初始化链接无效或已过期。', 401);
      if (!passwordValid(password)) fail('密码须为 12 到 128 个字符。', 400);
      const salt = secret();
      const passwordHash = await derive(password, salt);
      return transaction(db, () => {
        if (readConfig()) fail('登录密码已设置，初始化链接不能再次使用。', 409);
        const current = db.prepare('SELECT * FROM setup_tokens WHERE id=1').get();
        if (!current || current.token_hash !== issued.token_hash || current.expires_at <= at()) fail('初始化链接无效或已过期。', 401);
        db.prepare('INSERT INTO auth_config VALUES (1,?,?,?)').run(salt, passwordHash.toString('hex'), at());
        db.prepare('DELETE FROM setup_tokens').run();
        db.prepare('DELETE FROM sessions').run();
        return { configured: true };
      });
    },
    async login(password, req) {
      if (!readConfig()) fail('请先通过初始化链接设置登录密码。', 409);
      // Only an explicitly trusted loopback proxy may supply one valid X-Real-IP.
      // X-Forwarded-For is never used; Nginx must overwrite X-Real-IP from its socket peer.
      const address = clientAddress(req, config.trustLoopbackProxy);
      consume([[`ip:${address}`, 5], ['global', 30]]);
      if (!passwordValid(password)) fail('密码不正确。', 401);
      const current = readConfig();
      if (!isSecret(current.salt) || !/^[a-f0-9]{128}$/.test(current.password_hash)) fail('登录配置损坏，请由管理员检查。', 503);
      const derived = await derive(password, current.salt);
      if (!timingSafeEqual(derived, Buffer.from(current.password_hash, 'hex'))) fail('密码不正确。', 401);
      const token = secret();
      const timestamp = at();
      const expiresAt = timestamp + SESSION_MS;
      transaction(db, () => {
        const fresh = readConfig();
        if (!fresh || fresh.password_hash !== current.password_hash) fail('登录配置已变化，请重新登录。', 401);
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp);
        const old = sessionToken(req);
        if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(old));
        const excess = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count - 19;
        if (excess > 0) db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY created_at,token_hash LIMIT ?)').run(excess);
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), timestamp, expiresAt);
      });
      buckets.delete(`ip:${address}`);
      // Only the HTTP login handler may expose sessionToken, for the local frontend's sessionStorage.
      return { cookie: cookie(token, expiresAt), expiresAt: new Date(expiresAt).toISOString(), sessionToken: token };
    },
    async logout(req) {
      const token = sessionToken(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
      return cookie('', 0);
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

/** Called by an explicitly invoked local administrator command, never an HTTP route. */
export async function issueSetup(options) {
  const config = settings(options);
  const db = openAuthStore(config.dataDir);
  try {
    return transaction(db, () => {
      if (db.prepare('SELECT id FROM auth_config WHERE id=1').get()) fail('登录密码已设置，不能再签发初始化链接。', 409);
      const issuedAt = config.now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) fail('登录时钟无效。', 500);
      const token = secret();
      const expiresAt = issuedAt + SETUP_MS;
      db.prepare('INSERT INTO setup_tokens VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,issued_at=excluded.issued_at,expires_at=excluded.expires_at').run(hash(token), issuedAt, expiresAt);
      const frontend = config.frontendUrl || `${config.publicOrigin}${config.basePath}/`;
      return { token, url: `${frontend}#setup=${token}`, expiresAt: new Date(expiresAt).toISOString() };
    });
  } finally { db.close(); }
}
