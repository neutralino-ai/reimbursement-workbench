import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, linkSync, symlinkSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCloudAuth, issueSetup } from '../server/cloud-auth.mjs';

const password = 'A long test passphrase 42';
const origin = 'https://finance.example.test';
const request = (cookie = '', address = '192.0.2.1', extra = {}) => ({ headers: { cookie, ...extra }, socket: { remoteAddress: address } });
const cookieHeader = result => result.cookie.split(';')[0];
function clean(folder) {
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
  assert.ok(path.basename(folder).startsWith('reimbursement-cloud-auth-'));
  rmSync(folder, { recursive: true, force: true });
}
function fixture(t, overrides = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-cloud-auth-'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const options = { dataDir: folder, publicOrigin: origin, now: () => clock, ...overrides };
  let auth = createCloudAuth(options);
  t.after(() => { auth.close(); clean(folder); });
  return { folder, options, get auth() { return auth; }, advance(ms) { clock += ms; }, restart() { auth.close(); auth = createCloudAuth(options); } };
}

test('setup is expiring, single-use and atomic; configuration alone grants no session', async t => {
  const f = fixture(t);
  assert.deepEqual(f.auth.status(request()), { enabled: true, configured: false, authenticated: false });
  await assert.rejects(f.auth.login(password, request()), { statusCode: 409 });
  const obsolete = await issueSetup(f.options);
  const issued = await issueSetup(f.options);
  const url = new URL(issued.url);
  assert.equal(url.search, '');
  assert.equal(url.pathname, '/reimbursement/');
  assert.equal(url.hash, `#setup=${issued.token}`);
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  await assert.rejects(f.auth.setup({ token: obsolete.token, password }), { statusCode: 401 });
  await assert.rejects(f.auth.setup({ token: '0'.repeat(64), password }), { statusCode: 401 });
  await assert.rejects(f.auth.setup({ token: issued.token, password: 'too short' }), { statusCode: 400 });
  assert.equal(f.auth.status(request()).configured, false);
  f.advance(24 * 60 * 60 * 1000);
  await assert.rejects(f.auth.setup({ token: issued.token, password }), { statusCode: 401 });
  const fresh = await issueSetup(f.options);
  const results = await Promise.allSettled([f.auth.setup({ token: fresh.token, password }), f.auth.setup({ token: fresh.token, password: 'Different valid password 55' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.statusCode, 409);
  assert.deepEqual(f.auth.status(request()), { enabled: true, configured: true, authenticated: false });
  await assert.rejects(f.auth.setup({ token: fresh.token, password }), { statusCode: 409 });
  await assert.rejects(issueSetup(f.options), { statusCode: 409 });
  f.restart();
  assert.equal(f.auth.status(request()).configured, true);
  const bytes = readFileSync(path.join(f.folder, 'auth', 'cloud-auth.sqlite'));
  for (const value of [password, fresh.token, 'Different valid password 55']) assert.equal(bytes.includes(Buffer.from(value)), false, 'secrets must not be stored in plaintext');
});

test('password login creates protected hashed sessions, rotates the current session and revokes logout persistently', async t => {
  const f = fixture(t);
  const setup = await issueSetup(f.options);
  await f.auth.setup({ token: setup.token, password });
  await assert.rejects(f.auth.login('Incorrect test passphrase', request()), { statusCode: 401 });
  const first = await f.auth.login(password, request());
  assert.match(first.cookie, /^__Secure-ReimbursementSession=[a-f0-9]{64};/);
  for (const flag of ['Path=/reimbursement/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=604800']) assert.ok(first.cookie.includes(flag));
  assert.equal(f.auth.status(request(cookieHeader(first))).authenticated, true);
  assert.equal(f.auth.status(request(`${cookieHeader(first)}; ${cookieHeader(first)}`)).authenticated, false, 'ambiguous duplicate cookies are rejected');
  assert.equal(f.auth.status(request('__Secure-ReimbursementSession=forged')).authenticated, false);
  f.restart();
  assert.equal(f.auth.status(request(cookieHeader(first))).authenticated, true);
  const second = await f.auth.login(password, request(cookieHeader(first)));
  assert.notEqual(cookieHeader(first), cookieHeader(second));
  assert.equal(f.auth.status(request(cookieHeader(first))).authenticated, false);
  assert.equal(f.auth.status(request(cookieHeader(second))).authenticated, true);
  const dbBytes = readFileSync(path.join(f.folder, 'auth', 'cloud-auth.sqlite'));
  assert.equal(dbBytes.includes(Buffer.from(cookieHeader(second).split('=')[1])), false);
  const expired = await f.auth.logout(request(cookieHeader(second)));
  assert.match(expired, /Max-Age=0/);
  assert.match(expired, /HttpOnly/);
  f.restart();
  assert.equal(f.auth.status(request(cookieHeader(second))).authenticated, false);
  const third = await f.auth.login(password, request());
  f.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal(f.auth.status(request(cookieHeader(third))).authenticated, false);
});

test('login throttles socket peers and global attempts without trusting forwarded IP headers', async t => {
  const f = fixture(t);
  await f.auth.setup({ token: (await issueSetup(f.options)).token, password });
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.login('bad', request('', '192.0.2.7', { 'x-forwarded-for': `198.51.100.${index}` })), { statusCode: 401 });
  await assert.rejects(f.auth.login(password, request('', '192.0.2.7', { 'x-forwarded-for': '198.51.100.99' })), error => error.statusCode === 429 && error.retryAfter > 0);
  f.advance(15 * 60 * 1000);
  assert.equal(f.auth.status(request(cookieHeader(await f.auth.login(password, request('', '192.0.2.7'))))).authenticated, true);
  f.advance(15 * 60 * 1000);
  for (let index = 0; index < 30; index++) await assert.rejects(f.auth.login('bad', request('', `192.0.2.${index}`)), { statusCode: 401 });
  await assert.rejects(f.auth.login(password, request('', '203.0.113.200')), { statusCode: 429 });
});

test('cloud origin is HTTPS-only, cookie paths cannot inject attributes, and linked auth files are rejected', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-cloud-auth-'));
  try {
    for (const publicOrigin of ['http://finance.example.test', 'https://name:password@finance.example.test', 'https://finance.example.test/path', 'https://finance.example.test/#secret']) assert.throws(() => createCloudAuth({ dataDir: folder, publicOrigin }), { statusCode: 500 });
    assert.throws(() => createCloudAuth({ dataDir: folder, publicOrigin: origin, basePath: '/reimbursement; Domain=example.test' }), { statusCode: 500 });
    mkdirSync(path.join(folder, 'auth'));
    const other = path.join(folder, 'other-file');
    writeFileSync(other, 'must remain unchanged');
    linkSync(other, path.join(folder, 'auth', 'cloud-auth.sqlite'));
    assert.throws(() => createCloudAuth({ dataDir: folder, publicOrigin: origin }), { statusCode: 500 });
    assert.equal(readFileSync(other, 'utf8'), 'must remain unchanged');
  } finally { clean(folder); }
});

test('admin CLI keeps setup URL out of default stdout and stores it in a private local file', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-cloud-auth-'));
  try {
    const output = execFileSync(process.execPath, ['scripts/auth-admin.mjs', 'issue-setup', '--data-dir', folder, '--public-origin', origin], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.url, undefined);
    assert.equal(output.includes('#setup='), false);
    const stored = JSON.parse(readFileSync(result.setupFile, 'utf8'));
    assert.match(stored.url, /^https:\/\/finance\.example\.test\/reimbursement\/#setup=[a-f0-9]{64}$/);
    if (process.platform !== 'win32') assert.equal(statSync(result.setupFile).mode & 0o777, 0o600);
    const output2 = execFileSync(process.execPath, ['scripts/auth-admin.mjs', 'issue-setup', '--data-dir', folder, '--public-origin', 'https://x.test'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    const stored2 = JSON.parse(readFileSync(JSON.parse(output2).setupFile, 'utf8'));
    assert.match(stored2.url, /^https:\/\/x\.test\//);
    const output3 = execFileSync(process.execPath, ['scripts/auth-admin.mjs', 'issue-setup', '--data-dir', folder, '--public-origin', origin, '--frontend-url', 'http://127.0.0.1:4317/'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    const stored3 = JSON.parse(readFileSync(JSON.parse(output3).setupFile, 'utf8'));
    assert.match(stored3.url, /^http:\/\/127\.0\.0\.1:4317\/#setup=[a-f0-9]{64}$/);
    assert.equal(output3.includes('#setup='), false);
    assert.throws(() => execFileSync(process.execPath, ['scripts/auth-admin.mjs', 'issue-setup', '--data-dir', folder, '--public-origin', origin, '--frontend-url', 'http://untrusted.example.test/'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1);
  } finally { clean(folder); }
});

test('auth storage refuses a symlinked private directory', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-cloud-auth-'));
  try {
    const target = path.join(folder, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, path.join(folder, 'auth'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createCloudAuth({ dataDir: folder, publicOrigin: origin }), { statusCode: 500 });
    assert.throws(() => statSync(path.join(target, 'cloud-auth.sqlite')), { code: 'ENOENT' });
  } finally { clean(folder); }
});

test('X-Real-IP is ignored by default even when the socket peer is loopback', async t => {
  const f = fixture(t);
  await f.auth.setup({ token: (await issueSetup(f.options)).token, password });
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.login('bad', request('', '127.0.0.1', { 'x-real-ip': `198.51.100.${index}` })), { statusCode: 401 });
  await assert.rejects(f.auth.login('bad', request('', '127.0.0.1', { 'x-real-ip': '198.51.100.99' })), { statusCode: 429 });
});

test('trusted loopback proxy isolates clients while remote spoofing and malformed address lists remain limited', async t => {
  const f = fixture(t, { trustLoopbackProxy: true });
  await f.auth.setup({ token: (await issueSetup(f.options)).token, password });
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.login('bad', request('', '192.0.2.7', { 'x-real-ip': `198.51.100.${index}` })), { statusCode: 401 });
  await assert.rejects(f.auth.login('bad', request('', '192.0.2.7', { 'x-real-ip': '198.51.100.99' })), { statusCode: 429 }, 'non-loopback peers cannot select another rate key');

  f.advance(15 * 60 * 1000);
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.login('bad', request('', '127.0.0.1', { 'x-real-ip': '203.0.113.1' })), { statusCode: 401 });
  await assert.rejects(f.auth.login('bad', request('', '127.0.0.1', { 'x-real-ip': '203.0.113.1' })), { statusCode: 429 });
  await assert.rejects(f.auth.login('bad', request('', '127.0.0.1', { 'x-real-ip': '203.0.113.2' })), { statusCode: 401 }, 'a second proxied client has its own limit');

  f.advance(15 * 60 * 1000);
  for (const value of ['203.0.113.1, 203.0.113.2', ['203.0.113.1', '203.0.113.2'], 'client.example.test', '203.0.113.1:443', '[2001:db8::1]']) await assert.rejects(f.auth.login('bad', request('', '::1', { 'x-real-ip': value, 'x-forwarded-for': '203.0.113.50' })), { statusCode: 401 });
  await assert.rejects(f.auth.login('bad', request('', '::1', { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.99' })), { statusCode: 429 }, 'invalid proxy values share the socket key; XFF is ignored');

  f.advance(15 * 60 * 1000);
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.login('bad', request('', '::ffff:127.0.0.1', { 'x-real-ip': '2001:db8::1' })), { statusCode: 401 });
  await assert.rejects(f.auth.login('bad', request('', '::ffff:127.0.0.1', { 'x-real-ip': '2001:0db8:0:0:0:0:0:1' })), { statusCode: 429 }, 'equivalent IPv6 spellings cannot bypass a client limit');
});

test('explicit human Session headers support rotation and logout without falling back to cookies or Agent Bearer', async t => {
  const f = fixture(t);
  await f.auth.setup({ token: (await issueSetup(f.options)).token, password });
  const first = await f.auth.login(password, request());
  assert.match(first.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(cookieHeader(first).split('=')[1], first.sessionToken);
  const sessionRequest = (token, cookie = '') => request(cookie, '192.0.2.1', { authorization: `Session ${token}` });
  assert.equal(f.auth.status(sessionRequest(first.sessionToken)).authenticated, true);
  assert.equal(f.auth.status(request('', '192.0.2.1', { authorization: `session ${first.sessionToken}` })).authenticated, true);
  assert.equal(f.auth.status(request(cookieHeader(first))).authenticated, true, 'existing cookie clients remain supported');
  for (const authorization of [`Session ${'0'.repeat(64)}`, 'Session malformed', `Session ${first.sessionToken}, Session ${first.sessionToken}`, `Bearer ${first.sessionToken}`, `Bearer ${'a'.repeat(64)}`, 'Basic ignored']) {
    assert.equal(f.auth.status(request(cookieHeader(first), '192.0.2.1', { authorization })).authenticated, false, 'explicit invalid or non-human auth cannot inherit cookie credentials');
  }
  assert.equal(f.auth.status(request('', '192.0.2.1', { authorization: `Bearer ${first.sessionToken}` })).authenticated, false, 'a human session is never an Agent Bearer credential');
  await f.auth.logout(sessionRequest('0'.repeat(64), cookieHeader(first)));
  assert.equal(f.auth.status(sessionRequest(first.sessionToken)).authenticated, true, 'invalid header logout does not fall back to revoking an ambient cookie session');
  const second = await f.auth.login(password, sessionRequest(first.sessionToken));
  assert.equal(f.auth.status(sessionRequest(first.sessionToken)).authenticated, false);
  assert.equal(f.auth.status(request(cookieHeader(first))).authenticated, false);
  assert.equal(f.auth.status(sessionRequest(second.sessionToken)).authenticated, true);
  const dbBytes = readFileSync(path.join(f.folder, 'auth', 'cloud-auth.sqlite'));
  assert.equal(dbBytes.includes(Buffer.from(second.sessionToken)), false);
  const third = await f.auth.login(password, request());
  await f.auth.logout(sessionRequest(second.sessionToken, cookieHeader(third)));
  f.restart();
  assert.equal(f.auth.status(sessionRequest(second.sessionToken)).authenticated, false);
  assert.equal(f.auth.status(request(cookieHeader(third))).authenticated, true, 'the explicit header chooses which session is revoked');
  f.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal(f.auth.status(sessionRequest(third.sessionToken)).authenticated, false);
});

test('setup links can target a separate HTTPS or loopback HTTP frontend without placing secrets in queries', async t => {
  const f = fixture(t);
  for (const [frontendUrl, expected] of [
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173/'],
    ['http://localhost:4317/app/', 'http://localhost:4317/app/'],
    ['http://[::1]:5173/ui', 'http://[::1]:5173/ui/'],
    ['https://frontend.example.test/expenses/', 'https://frontend.example.test/expenses/'],
  ]) {
    const issued = await issueSetup({ ...f.options, frontendUrl });
    assert.equal(issued.url, `${expected}#setup=${issued.token}`);
    assert.equal(new URL(issued.url).search, '');
  }
  for (const frontendUrl of [
    'http://frontend.example.test/', 'http://localhost.evil.test/', 'http://192.168.1.2/',
    'https://name:password@frontend.example.test/', 'https://frontend.example.test/?token=bad',
    'https://frontend.example.test/#bad', 'https://frontend.example.test/?', 'https://frontend.example.test/#',
    'https://frontend.example.test/\n', 'https://frontend.example.test\\other', 'file:///tmp/frontend/',
  ]) await assert.rejects(issueSetup({ ...f.options, frontendUrl }), { statusCode: 500 });
  await assert.rejects(issueSetup({ ...f.options, publicOrigin: 'http://127.0.0.1:4317', frontendUrl: 'http://localhost:5173' }), { statusCode: 500 }, 'backend public origin still requires HTTPS');
});
