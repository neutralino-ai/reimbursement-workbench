import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFrontendServer, frontendIdentity } from '../scripts/frontend-server.mjs';
import { probeFrontend } from '../scripts/open-workbench.mjs';

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(tmpdir(), 'reimbursement-static-test-'));
  const dist = path.join(folder, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Static fixture</title><script src="/assets/main.js"></script>');
  fs.writeFileSync(path.join(dist, 'assets', 'main.js'), 'console.log("static fixture")');
  fs.writeFileSync(path.join(dist, 'frontend-config.json'), JSON.stringify({ apiBaseUrl: 'https://api.example.test/reimbursement' }));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('reimbursement-static-test-'));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return { folder, dist };
}

async function listen(t, app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); });
  const port = app.server.address().port;
  const request = (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
  return { request, url: `http://127.0.0.1:${port}/` };
}

test('frontend serves build files and public configuration only, with no local ledger or API fallback', async t => {
  const { folder, dist } = fixture(t);
  fs.writeFileSync(path.join(folder, 'private.js'), 'PRIVATE SOURCE');
  fs.mkdirSync(path.join(dist, 'src'));
  fs.writeFileSync(path.join(dist, 'src', 'private.js'), 'PRIVATE SOURCE');
  fs.writeFileSync(path.join(dist, 'agent-access.json'), '{"token":"PRIVATE TOKEN"}');
  const app = createFrontendServer({ distDir: dist });
  const { request, url } = await listen(t, app);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Static fixture/);
  assert.equal(home.headers['x-reimbursement-frontend'], frontendIdentity);
  assert.match(home.headers['content-security-policy'], /connect-src 'self' https:\/\/api\.example\.test/);
  assert.match(home.headers['content-security-policy'], /img-src 'self' blob: data:/);
  assert.deepEqual(JSON.parse((await request('/frontend-config.json')).text), { apiBaseUrl: 'https://api.example.test/reimbursement' });
  assert.match((await request('/assets/main.js')).headers['content-type'], /javascript/);
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const target of ['/api', '/api/workspace', '/api/materials/secret', '/src/private.js', '/server/index.mjs', '/agent-access.json', '/client-connection.json', '/package.json', '/assets/main.js.map', '/missing-route']) {
    const response = await request(target);
    assert.equal(response.status, 404, target);
    assert.equal(response.text.includes('PRIVATE'), false);
    assert.equal(response.text.includes('<title>'), false, 'unknown routes do not fall back to an app/API response');
  }
  assert.equal((await request('/api/workspace', { method: 'POST' })).status, 405);
  assert.equal((await request('/', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal(await probeFrontend(url), 'ready');
  assert.equal(fs.existsSync(path.join(folder, 'data')), false);
  assert.equal(fs.readdirSync(folder).some(name => name.endsWith('.sqlite')), false);
});

test('frontend rejects raw and encoded traversal plus symlink/junction escapes', async t => {
  const { folder, dist } = fixture(t);
  const outside = path.join(folder, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.js'), 'PRIVATE ESCAPE');
  fs.symlinkSync(outside, path.join(dist, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const { request } = await listen(t, createFrontendServer({ distDir: dist }));
  for (const target of ['/../outside/secret.js', '/%2e%2e/outside/secret.js', '/assets/../../outside/secret.js', '/assets/%2e%2e/%2e%2e/outside/secret.js', '/assets%5cescape%5csecret.js', '/assets/escape/secret.js']) {
    const response = await request(target);
    assert.equal(response.status, 403, target);
    assert.equal(response.text.includes('PRIVATE'), false);
  }
  assert.equal((await request('/%zz')).status, 400);
});

test('frontend configuration forbids credentials and the launcher rejects unrelated HTTP listeners', async t => {
  const { dist } = fixture(t);
  for (const config of [{ apiBaseUrl: 'https://user:secret@example.test' }, { apiBaseUrl: 'https://example.test?token=secret' }, { apiBaseUrl: 'http://remote.example.test' }, { apiBaseUrl: 'https://example.test', token: 'should-not-be-public' }]) {
    fs.writeFileSync(path.join(dist, 'frontend-config.json'), JSON.stringify(config));
    assert.throws(() => createFrontendServer({ distDir: dist }), error => !error.message.includes('secret'));
  }
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('old backend'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const occupiedURL = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await probeFrontend(occupiedURL), 'occupied');
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  assert.equal(await probeFrontend(occupiedURL), 'absent');
});
