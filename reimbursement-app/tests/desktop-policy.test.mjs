import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { APP_ORIGIN, validateConnection, isAppDocument, isAppBlob, externalHTTPS, contentSecurityPolicy, staticResource, inspectBundle } = require('../desktop/policy.cjs');
const connection = { apiBaseUrl: 'https://api.example.test/reimbursement' };

test('desktop connection accepts a public HTTPS endpoint, never credentials or insecure transport', () => {
  assert.deepEqual(validateConnection({ apiBaseUrl: ' https://api.example.test/reimbursement/ ' }), connection);
  for (const value of [
    { apiBaseUrl: 'http://127.0.0.1:4320' }, { apiBaseUrl: 'file:///private' },
    { apiBaseUrl: 'https://user:password@api.example.test' },
    { apiBaseUrl: 'https://api.example.test?token=secret' },
    { apiBaseUrl: 'https://api.example.test#secret' },
    { apiBaseUrl: 'https://api.example.test', token: 'secret' },
    { apiBaseUrl: 'https://api.example.test/back\\slash' },
    { apiBaseUrl: 'https://api.example.test/%0a' }, [], null,
  ]) assert.throws(() => validateConnection(value));
  assert.equal(contentSecurityPolicy(connection).includes('connect-src \'self\' https://api.example.test;'), true);
  assert.equal(contentSecurityPolicy(connection).includes('unsafe-eval'), false);
});

test('desktop only grants main-document privilege and attachment navigation to exact local URLs', () => {
  assert.equal(isAppDocument(`${APP_ORIGIN}/#setup=redacted`), true);
  assert.equal(isAppDocument(`${APP_ORIGIN}/index.html`), true);
  for (const value of ['reimbursement://app.evil/', 'reimbursement://user@app/', 'reimbursement://app:80/', 'reimbursement://app/assets/a.js', 'https://app/', 'about:blank', 'reimbursement://app/?query']) assert.equal(isAppDocument(value), false, value);
  assert.equal(isAppBlob('blob:reimbursement://app/12345678-1234-1234-1234-123456789abc#page=2'), true);
  for (const value of ['blob:https://api.example.test/12345678-1234-1234-1234-123456789abc', 'blob:reimbursement://app.evil/12345678-1234-1234-1234-123456789abc', 'file:///invoice.pdf', 'javascript:alert(1)']) assert.equal(isAppBlob(value), false);
  assert.equal(externalHTTPS('https://www.boc.cn/'), 'https://www.boc.cn/');
  for (const value of ['javascript:alert(1)', 'file:///private', 'http://example.test/', 'https://user:password@example.test/']) assert.equal(externalHTTPS(value), null);
});

test('desktop custom protocol exposes only built frontend assets and public dynamic config', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-desktop-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'desktop'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'export {};');
  fs.writeFileSync(path.join(dist, 'frontend-config.json'), JSON.stringify(connection));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const filename of ['main.cjs', 'preload.cjs', 'policy.cjs']) fs.writeFileSync(path.join(root, 'desktop', filename), '');
  assert.equal(staticResource(dist, `${APP_ORIGIN}/`, connection).status, 200);
  assert.equal(staticResource(dist, `${APP_ORIGIN}/assets/app.js`, connection).status, 200);
  const changed = { apiBaseUrl: 'https://second.example.test/api-service' };
  assert.deepEqual(JSON.parse(staticResource(dist, `${APP_ORIGIN}/frontend-config.json`, changed).bytes.toString()), changed);
  for (const value of ['/api/workspace', '/data/database.sqlite', '/client-private/agent-token', '/assets/%2e%2e%5csecret.js', '/%00.js', '/package.json', '/assets/../../desktop/main.cjs', '/index.html?token=secret']) assert.notEqual(staticResource(dist, APP_ORIGIN + value, connection).status, 200, value);
  assert.equal(staticResource(dist, 'reimbursement://other/index.html', connection).status, 403);
  assert.equal(staticResource(dist, 'https://api.example.test/index.html', connection).status, 403);
  assert.equal(inspectBundle(root, { packaged: true }).valid, true);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'private.txt'), 'private');
  assert.throws(() => inspectBundle(root, { packaged: true }), /安装包/);
});

test('desktop static files cannot escape the frontend directory through directory links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-desktop-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  const secret = path.join(root, 'private');
  fs.mkdirSync(dist); fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'secret.js'), 'private');
  try { fs.symlinkSync(secret, path.join(dist, 'assets'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit symlinks'); return; } throw error; }
  assert.notEqual(staticResource(dist, `${APP_ORIGIN}/assets/secret.js`, connection).status, 200);
});
