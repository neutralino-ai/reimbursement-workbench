import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentRuntime, parseRuntimeArgs, appDirectory } from '../server/agent-runtime.mjs';

const token = 'a1'.repeat(32);

function directory(t) {
  const root = path.resolve(tmpdir());
  const folder = mkdtempSync(path.join(root, 'reimbursement-remote-agent-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), root);
    assert.ok(path.basename(folder).startsWith('reimbursement-remote-agent-'));
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

async function mockAPI(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(request);
    handler(request, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

function remoteOptions(folder, apiUrl) {
  const tokenFile = path.join(folder, 'agent-token');
  writeFileSync(tokenFile, `${token}\r\n`, { mode: 0o600 });
  return { apiUrl, tokenFile, dataDir: path.join(folder, 'must-not-create'), actorId: 'remote-transport-test' };
}

test('remote runtime sends authenticated commands, preserves versions/replay, and never opens local data', async t => {
  const folder = directory(t);
  const observed = new Map();
  const api = await mockAPI(t, (req, res) => {
    const command = JSON.parse(req.body);
    if (command.type === 'workspace.get') return json(res, 200, { records: [{ id: 'remote-record', version: '8@remote' }] });
    if (command.type === 'tasks.list') return json(res, 200, { tasks: [] });
    if (command.type === 'history.list') return json(res, 200, { changes: [] });
    const replayed = observed.has(command.operationId);
    observed.set(command.operationId, command);
    return json(res, 200, { operationId: command.operationId, replayed, data: { id: 'remote-record', version: '9@remote' } });
  });
  const options = remoteOptions(folder, api.url + '/reimbursement/');
  const runtime = createAgentRuntime(options);
  t.after(() => runtime.close());
  assert.equal(existsSync(options.dataDir), false);
  assert.equal((await runtime.execute('workspace.get', {})).records[0].version, '8@remote');
  assert.deepEqual(await runtime.execute('tasks.list', { payload: {} }), { tasks: [] });
  assert.deepEqual(await runtime.execute('history.list', { payload: { entityType: 'policy', limit: 5 } }), { changes: [] });
  const args = { operationId: 'remote-write', baseVersion: '8@remote', payload: { recordID: 'remote-record', claimedCNY: '1400.00', note: 'Synthetic claim only', evidenceIDs: ['fixture-evidence'] } };
  assert.equal((await runtime.execute('record.patch', args)).replayed, false);
  assert.equal((await runtime.execute('record.patch', args)).replayed, true);
  for (const request of api.requests) {
    assert.equal(request.url, '/reimbursement/api/agent/commands');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(request.body).actor, { type: 'agent', id: 'remote-transport-test' });
  }
  assert.deepEqual(observed.get('remote-write'), { ...args, type: 'record.patch', actor: { type: 'agent', id: 'remote-transport-test' } });
  await assert.rejects(runtime.execute('workspace.get', { payload: {}, actor: { type: 'human', id: 'user' } }), { statusCode: 400 });
  await assert.rejects(runtime.execute('verification.set', {}), { statusCode: 404 });
  await assert.rejects(runtime.execute('material.import', { operationId: 'bad', payload: {} }), { statusCode: 400 });
  assert.equal(api.requests.length, 5, 'invalid commands do not reach the remote server');
  runtime.close();
  await assert.rejects(runtime.execute('workspace.get', {}), { statusCode: 409 });
  assert.equal(existsSync(options.dataDir), false);
});

test('remote material imports transmit the exact original bytes and keep localPath private', async t => {
  const folder = directory(t);
  const api = await mockAPI(t, (req, res) => json(res, 200, { data: { id: 'material-from-remote' }, replayed: false }));
  const options = remoteOptions(folder, api.url);
  const runtime = createAgentRuntime(options);
  t.after(() => runtime.close());
  const filename = path.join(folder, 'invoice-original.pdf');
  const bytes = Buffer.from('%PDF-1.4\nSynthetic remote transport test only.\n%%EOF\n');
  writeFileSync(filename, bytes);
  await runtime.execute('material.import', { operationId: 'upload-original', payload: { localPath: filename, role: 'invoice', source: { kind: 'user-upload' } } });
  const command = JSON.parse(api.requests[0].body);
  assert.equal(command.payload.filename, 'invoice-original.pdf');
  assert.equal(Object.hasOwn(command.payload, 'localPath'), false);
  assert.deepEqual(Buffer.from(command.payload.contentBase64, 'base64'), bytes);
  assert.deepEqual(readFileSync(filename), bytes);
  assert.equal(existsSync(options.dataDir), false);
  await assert.rejects(runtime.execute('material.import', { operationId: 'relative', payload: { localPath: 'relative.pdf', role: 'invoice', source: { kind: 'user-upload' } } }), { statusCode: 400 });
});

test('remote HTTP failures preserve status, redact credentials and never follow redirects', async t => {
  const folder = directory(t);
  const destination = await mockAPI(t, (req, res) => json(res, 200, { unexpected: true }));
  const api = await mockAPI(t, (req, res) => {
    const type = JSON.parse(req.body).type;
    if (type === 'workspace.get') return json(res, 409, { error: `Version conflict; accidental credential ${token} and Bearer ${token}.` });
    if (type === 'tasks.list') { res.writeHead(307, { Location: destination.url + '/stolen' }); return res.end(); }
    res.writeHead(502, { 'Content-Type': 'text/html' }); res.end(`Invalid upstream ${token}`);
  });
  const runtime = createAgentRuntime(remoteOptions(folder, api.url));
  t.after(() => runtime.close());
  await assert.rejects(runtime.execute('workspace.get', {}), error => error.statusCode === 409 && /Version conflict/.test(error.message) && !error.message.includes(token));
  await assert.rejects(runtime.execute('tasks.list', {}), error => error.statusCode === 502 && /redirects/.test(error.message) && !error.message.includes(token));
  assert.equal(destination.requests.length, 0);
  await assert.rejects(runtime.execute('history.list', {}), error => error.statusCode === 502 && !error.message.includes(token));
});

test('remote configuration rejects unsafe URLs and invalid token files without creating a local ledger', t => {
  const folder = directory(t);
  const options = remoteOptions(folder, 'https://example.test/reimbursement');
  for (const apiUrl of ['http://example.test/', 'https://user:password@example.test/', 'https://example.test/?token=secret', 'https://example.test/#secret', 'https://example.test/?', 'ftp://example.test/', 'not a URL']) {
    assert.throws(() => createAgentRuntime({ ...options, apiUrl }), error => error.statusCode === 400 && !error.message.includes('password'));
  }
  for (const value of ['invalid-private-credential', 'a'.repeat(4097), '']) {
    writeFileSync(options.tokenFile, value);
    assert.throws(() => createAgentRuntime(options), error => error.statusCode === 400 && (!value || !error.message.includes(value)));
  }
  assert.throws(() => createAgentRuntime({ ...options, tokenFile: path.join(folder, 'missing-token') }), { statusCode: 400 });
  assert.equal(existsSync(options.dataDir), false);
});

test('saved remote configuration, environment and explicit CLI flags have predictable precedence; --local is explicit', t => {
  const folder = directory(t);
  const config = path.join(folder, 'client-connection.json');
  writeFileSync(config, JSON.stringify({ apiUrl: 'https://saved.example/reimbursement', tokenFile: 'private-token' }));
  const keys = ['REIMBURSE_API_URL', 'REIMBURSE_AGENT_TOKEN_FILE'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  for (const key of keys) delete process.env[key];
  const parse = argv => parseRuntimeArgs(argv, { cli: true, connectionFile: config });
  assert.equal(parse([]).apiUrl, 'https://saved.example/reimbursement');
  assert.equal(parse([]).tokenFile, path.join(folder, 'private-token'));
  process.env.REIMBURSE_API_URL = 'https://environment.example/reimbursement';
  process.env.REIMBURSE_AGENT_TOKEN_FILE = path.join(folder, 'env-token');
  assert.equal(parse([]).apiUrl, process.env.REIMBURSE_API_URL);
  assert.equal(parse([]).tokenFile, process.env.REIMBURSE_AGENT_TOKEN_FILE);
  assert.equal(parse(['--api-url', 'https://explicit.example/reimbursement', '--token-file', 'explicit-token']).apiUrl, 'https://explicit.example/reimbursement');
  assert.equal(parse(['--api-url', 'https://explicit.example/reimbursement', '--token-file', 'explicit-token']).tokenFile, 'explicit-token');
  assert.throws(() => parse(['--data-dir', folder]), /--local/);
  assert.throws(() => parse(['--legacy-dir', folder]), /--local/);
  assert.equal(parse(['--api-url', 'https://explicit.example', '--data-dir', folder]).dataDir, folder);
  const local = parse(['--local', '--data-dir', path.join(folder, 'local-data')]);
  assert.equal(local.apiUrl, undefined);
  assert.equal(local.tokenFile, undefined);
  const runtime = createAgentRuntime(local);
  runtime.close();
  assert.equal(existsSync(path.join(local.dataDir, 'reimbursement.sqlite')), true);
  assert.throws(() => parse(['--local', '--api-url', 'https://example.test']), /cannot be combined/);
  writeFileSync(config, 'invalid JSON');
  assert.throws(() => parse([]), /client-connection.json/);
  assert.equal(parse(['--local']).local, true, '--local bypasses broken configuration too');
});

test('CLI remote flags route through HTTP and preserve JSON without creating local SQLite', { timeout: 15000 }, async t => {
  const folder = directory(t);
  const api = await mockAPI(t, (req, res) => json(res, 200, { records: [{ id: 'from-cli-remote' }] }));
  const options = remoteOptions(folder, api.url + '/reimbursement');
  const commandFile = path.join(folder, 'command.json');
  writeFileSync(commandFile, JSON.stringify({ type: 'workspace.get', payload: {} }));
  const child = spawn(process.execPath, [path.join(appDirectory, 'scripts/agent-cli.mjs'), '--api-url', options.apiUrl, '--token-file', options.tokenFile, '--data-dir', options.dataDir, '--file', commandFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).records[0].id, 'from-cli-remote');
  assert.equal(stdout.includes(token) || stderr.includes(token), false);
  assert.equal(api.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(existsSync(options.dataDir), false);
});

test('MCP stdio uses the remote ledger and retains agent identity', { timeout: 15000 }, async t => {
  const folder = directory(t);
  const api = await mockAPI(t, (req, res) => json(res, 200, { tasks: [{ id: 'remote-task' }] }));
  const options = remoteOptions(folder, api.url + '/reimbursement');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(appDirectory, 'server/mcp.mjs'), '--api-url', options.apiUrl, '--token-file', options.tokenFile, '--data-dir', options.dataDir, '--actor-id', 'remote-mcp'], stderr: 'pipe' });
  const client = new Client({ name: 'remote-reimbursement-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'policy.register'));
  const result = await client.callTool({ name: 'tasks.list', arguments: { payload: {} } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { tasks: [{ id: 'remote-task' }] });
  assert.deepEqual(JSON.parse(api.requests[0].body).actor, { type: 'agent', id: 'remote-mcp' });
  assert.equal(api.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(existsSync(options.dataDir), false);
  const forged = await client.callTool({ name: 'tasks.list', arguments: { payload: {}, actor: { type: 'human', id: 'user' } } });
  assert.equal(forged.isError, true);
  assert.equal(api.requests.length, 1);
});
