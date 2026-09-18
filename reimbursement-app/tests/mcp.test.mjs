import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const unrelatedRemoteEnvironment = directory => ({
  ...process.env,
  REIMBURSE_API_URL: 'https://remote-fixture.invalid/reimbursement',
  REIMBURSE_AGENT_TOKEN_FILE: path.join(directory, 'must-not-read-agent-token'),
});

function tempDirectory() {
  const tempRoot = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, 'reimbursement-mcp-test-'));
  const cleanup = () => {
    const resolved = path.resolve(directory);
    const relative = path.relative(tempRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(resolved).startsWith('reimbursement-mcp-test-'));
    rmSync(resolved, { recursive: true, force: true });
  };
  return { directory, cleanup };
}

async function connect(t) {
  const { directory, cleanup } = tempDirectory();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(appDir, 'server/mcp.mjs'), '--local', '--data-dir', path.join(directory, 'data'), '--actor-id', 'mcp-integration-test'], cwd: appDir, env: unrelatedRemoteEnvironment(directory), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'reimbursement-test-client', version: '1.0.0' });
  t.after(async () => { await client.close(); cleanup(); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${error.message}\n${stderr}`); }
  return { client, directory };
}

const outputOf = result => result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);

test('real stdio client negotiates MCP, lists schemas and queries an isolated local workspace', { timeout: 20000 }, async t => {
  const { client } = await connect(t);
  assert.equal(client.getServerVersion().name, 'reimbursement-workbench');
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'material.import' && tool.inputSchema.type === 'object'));
  assert.ok(tools.some(tool => tool.name === 'document.register'));
  assert.ok(tools.some(tool => tool.name === 'exchangeRate.set'));
  assert.ok(!tools.some(tool => tool.name === 'verification.set'));
  const workspace = await client.callTool({ name: 'workspace.get', arguments: { payload: {} } });
  assert.notEqual(workspace.isError, true);
  assert.equal(outputOf(workspace).records.length, 0);
  const tasks = await client.callTool({ name: 'tasks.list', arguments: { payload: {} } });
  assert.notEqual(tasks.isError, true);
  assert.ok(outputOf(tasks));
});

test('MCP rejects fabricated human identities and invalid schemas before mutation', { timeout: 20000 }, async t => {
  const { client } = await connect(t);
  const human = await client.callTool({ name: 'workspace.get', arguments: { actor: { type: 'human', id: 'user' }, payload: {} } });
  assert.equal(human.isError, true);
  assert.match(outputOf(human).error, /actor/);
  const verify = await client.callTool({ name: 'verification.set', arguments: { operationId: 'forged-verification', payload: {} } });
  assert.equal(verify.isError, true);
  const bad = await client.callTool({ name: 'material.import', arguments: { operationId: 'bad-import', payload: {} } });
  assert.equal(bad.isError, true);
  const history = await client.callTool({ name: 'history.list', arguments: { payload: {} } });
  assert.notEqual(history.isError, true);
});

test('MCP imports an original by local path, retries idempotently, records evidence and registers output', { timeout: 20000 }, async t => {
  const { client, directory } = await connect(t);
  const original = path.join(directory, 'invoice.pdf');
  const originalBytes = Buffer.from('%PDF-1.4\n% synthetic MCP transport fixture, not a financial invoice\n%%EOF');
  writeFileSync(original, originalBytes);
  const source = { kind: 'user-upload', note: 'Synthetic integration fixture only.' };
  const importArguments = { operationId: 'mcp-import-original', payload: { localPath: original, role: 'invoice', source } };
  const imported = await client.callTool({ name: 'material.import', arguments: importArguments });
  assert.notEqual(imported.isError, true, JSON.stringify(imported));
  const material = outputOf(imported).data;
  assert.equal(material.sha256, createHash('sha256').update(originalBytes).digest('hex'));
  assert.deepEqual(readFileSync(original), originalBytes, 'original remains unchanged');
  const retried = await client.callTool({ name: 'material.import', arguments: importArguments });
  assert.equal(outputOf(retried).replayed, true);
  assert.equal(outputOf(retried).data.id, material.id);

  const invoice = await client.callTool({ name: 'invoice.upsert', arguments: { operationId: 'mcp-invoice', baseVersion: 'new', payload: { id: 'mcp-record', accountID: 'mcp-gpt', accountName: 'Test GPT', vendor: 'chatgpt', invoiceNumber: 'MCP-SYNTHETIC-1', date: '2026-01-25', billingMonth: '2026-01', amount: '200.00', currency: 'USD', evidenceIDs: [material.id] } } });
  assert.notEqual(invoice.isError, true, JSON.stringify(invoice));
  const state = outputOf(await client.callTool({ name: 'workspace.get', arguments: {} }));
  let record = state.records.find(item => item.id === 'mcp-record');
  assert.equal(record.humanVerification.status, 'unreviewed');
  assert.equal(record.lastModified.actor.type, 'agent');
  assert.equal(record.lastModified.actor.id, 'mcp-integration-test');

  const screenshotPath = path.join(directory, 'boc-synthetic.png');
  writeFileSync(screenshotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'));
  const fxImport = await client.callTool({ name: 'material.import', arguments: { operationId: 'mcp-fx-image', payload: { localPath: screenshotPath, role: 'exchangeRate', source: { kind: 'browser-observation', url: 'https://www.boc.cn/sourcedb/whpj/', note: 'Synthetic pixel only, not an actual BOC quote.' } } } });
  assert.notEqual(fxImport.isError, true, JSON.stringify(fxImport));
  const fxArguments = { operationId: 'mcp-fx-set', baseVersion: record.version, payload: { recordID: record.id, date: record.date, currency: 'USD', provider: 'BOC', rateType: '中行折算价', quotedRate: '700.0000', unit: 100, sourceUrl: 'https://www.boc.cn/sourcedb/whpj/', evidenceIDs: [outputOf(fxImport).data.id], note: 'Synthetic MCP validation fixture.' } };
  const fx = await client.callTool({ name: 'exchangeRate.set', arguments: fxArguments });
  assert.notEqual(fx.isError, true, JSON.stringify(fx));
  record = outputOf(fx).data;
  assert.equal(record.exchangeRate.valid, true);
  assert.equal(record.exchangeRate.cnyAmount, '1400.00');
  assert.equal(record.claimConfirmed, false);
  assert.equal(outputOf(await client.callTool({ name: 'exchangeRate.set', arguments: fxArguments })).replayed, true);

  const reportPath = path.join(directory, 'draft.pdf');
  writeFileSync(reportPath, Buffer.from('%PDF-1.4\n% generated draft fixture\n%%EOF'));
  const generated = await client.callTool({ name: 'material.import', arguments: { operationId: 'mcp-import-report', payload: { localPath: reportPath, role: 'document', source: { kind: 'generated', note: 'Draft test output.' } } } });
  assert.notEqual(generated.isError, true);
  const document = await client.callTool({ name: 'document.register', arguments: { operationId: 'mcp-register-document', baseVersion: 'new', payload: { id: 'mcp-report', title: 'Synthetic reimbursement draft', materialIDs: [outputOf(generated).data.id], recordIDs: [record.id], sourceRecordVersions: { [record.id]: record.version }, sourceMaterialIDs: [material.id], status: 'draft', note: 'Synthetic integration test; no rendered financial document.' } } });
  assert.notEqual(document.isError, true, JSON.stringify(document));
  const final = outputOf(await client.callTool({ name: 'workspace.get', arguments: {} }));
  assert.equal(final.documents.length, 1);
  assert.equal(final.documents[0].status, 'draft');
  assert.equal(final.records[0].humanVerification.status, 'unreviewed');
  assert.equal(final.records[0].submissionReference, '');
});

test('CLI queries the same service without an HTTP server and reports command errors', t => {
  const { directory, cleanup } = tempDirectory();
  t.after(cleanup);
  const commandFile = path.join(directory, 'command.json');
  writeFileSync(commandFile, JSON.stringify({ type: 'workspace.get', payload: {} }));
  const run = spawnSync(process.execPath, [path.join(appDir, 'scripts/agent-cli.mjs'), '--local', '--data-dir', path.join(directory, 'data'), '--file', commandFile], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: unrelatedRemoteEnvironment(directory) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).records.length, 0);
  writeFileSync(commandFile, JSON.stringify({ type: 'verification.set', payload: {} }));
  const invalid = spawnSync(process.execPath, [path.join(appDir, 'scripts/agent-cli.mjs'), '--local', '--data-dir', path.join(directory, 'data'), '--file', commandFile], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: unrelatedRemoteEnvironment(directory) });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Agent tool unavailable/);
});
