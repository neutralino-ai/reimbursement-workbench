import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';

function pdfBytes() {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const original = pdfBytes();
const importPayload = { filename: '制度汇编.pdf', role: 'policy', contentBase64: original.toString('base64'), source: { kind: 'user-upload', note: 'Synthetic test policy only' } };
const clause = { id: 'fx', topic: '汇率', section: '第十条', pdfPage: 1, printedPage: '1', quote: 'Synthetic fixture clause.', interpretation: 'Fixture interpretation.', scope: 'Synthetic test only.' };
function policyPayload(materialID) { return { id: 'institute-policy', title: '制度汇编', versionLabel: '2025-09', materialID, status: 'active', note: '原件作为规则依据；解释与原文分开。', clauses: [clause] }; }
function cleanup(folder) {
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
  assert.ok(path.basename(folder).startsWith('reimbursement-policy-'));
  rmSync(folder, { recursive: true, force: true });
}
function fixture(t) {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-policy-'));
  let store = createStore({ dataDir: folder });
  let next = 0;
  const execute = (type, payload, baseVersion, operationId = `op-${++next}`) => store.executeAgentCommand({ type, payload, baseVersion, operationId, actor: { type: 'agent', id: 'policy-test' } });
  t.after(() => { store.close(); cleanup(folder); });
  return { get store() { return store; }, execute, restart() { store.close(); store = createStore({ dataDir: folder }); } };
}

test('policy original, precise references and versions survive restart with safe replay', t => {
  const f = fixture(t);
  const material = f.execute('material.import', importPayload).data;
  assert.equal(material.sha256, createHash('sha256').update(original).digest('hex'));
  const payload = policyPayload(material.id);
  const first = f.execute('policy.register', payload, 'new', 'register-policy');
  assert.equal(first.data.integrity, 'ok');
  assert.equal(first.data.actor.type, 'agent');
  assert.deepEqual(first.data.clauses, [clause]);
  assert.deepEqual(readFileSync(f.store.material(material.id).path), original);
  f.restart();
  assert.equal(f.execute('policy.register', payload, 'new', 'register-policy').replayed, true);
  const changed = f.execute('policy.register', { ...payload, status: 'reference' }, first.data.version).data;
  assert.notEqual(changed.version, first.data.version);
  assert.throws(() => f.execute('policy.register', payload, first.data.version), { statusCode: 409 });
  assert.throws(() => f.execute('policy.register', { ...payload, status: 'reference' }, 'new', 'register-policy'), { statusCode: 409 });
  const history = f.store.history({ entityType: 'policy', entityID: payload.id });
  assert.equal(history.changes.length, 2);
  assert.equal(JSON.parse(history.changes[1].snapshot.raw).status, 'active');
  assert.equal(f.store.workspace().policies[0].material.id, material.id);
  assert.deepEqual(f.store.workspace().records, []);
});

test('policy validation rejects generated, renamed, truncated and changed originals without registration', t => {
  const f = fixture(t);
  for (const invalid of [
    { ...importPayload, filename: 'policy.png' },
    { ...importPayload, source: { kind: 'generated' } },
    { ...importPayload, source: { kind: 'browser-observation' } },
    { ...importPayload, contentBase64: Buffer.from('not a PDF').toString('base64') },
    { ...importPayload, contentBase64: original.subarray(0, -10).toString('base64') },
  ]) assert.throws(() => f.execute('material.import', invalid), { statusCode: 400 });
  assert.equal(f.store.workspace().materials.length, 0);
  const material = f.execute('material.import', importPayload).data;
  const payload = policyPayload(material.id);
  assert.throws(() => f.execute('policy.register', { ...payload, clauses: [{ ...clause, pdfPage: 0 }] }, 'new'), { statusCode: 400 });
  assert.throws(() => f.execute('policy.register', { ...payload, clauses: [clause, clause] }, 'new'), { statusCode: 400 });
  const wrongRole = f.execute('material.import', { ...importPayload, role: 'invoice' }).data;
  assert.throws(() => f.execute('policy.register', { ...payload, materialID: wrongRole.id }, 'new'), { statusCode: 400 });
  f.execute('policy.register', payload, 'new');
  const materialPath = f.store.material(material.id).path;
  writeFileSync(materialPath, 'Changed fixture');
  assert.equal(f.store.workspace().policies[0].integrity, 'changed');
  assert.throws(() => f.execute('policy.register', payload, f.store.workspace().policies[0].version), { statusCode: 409 });
  assert.throws(() => f.store.material(material.id), { statusCode: 409 });
});

test('local policy upload and maintenance preserve human identity, security and original downloads', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-policy-'));
  const application = await createApp({ dataDir: path.join(folder, 'data'), legacyDir: path.join(folder, 'empty-legacy') });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const upload = { filename: importPayload.filename, contentBase64: importPayload.contentBase64, title: '用户制度', versionLabel: '2025-09', note: 'Synthetic upload', operationId: 'ui-upload' };
  const post = (route, payload, headers = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  try {
    assert.equal((await post('/api/policies/upload', upload, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post('/api/policies/upload', upload, { Authorization: 'Bearer blocked' })).status, 403);
    assert.equal((await post('/api/policies/upload', { ...upload, actor: { type: 'agent' } })).status, 400);
    const response = await post('/api/policies/upload', upload);
    assert.equal(response.status, 200);
    const result = await response.json();
    const policy = result.data;
    assert.equal(policy.status, 'reference');
    assert.deepEqual(policy.clauses, []);
    assert.equal(policy.actor.type, 'human');
    assert.equal((await (await post('/api/policies/upload', upload)).json()).replayed, true);
    assert.equal((await post('/api/policies/upload', { ...upload, title: 'Different request' })).status, 409);
    const inline = await fetch(base + policy.material.href);
    assert.match(inline.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), original);
    const download = await fetch(base + policy.material.href + '?download=1');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const route = `/api/policies/${encodeURIComponent(policy.id)}`;
    const edit = { title: policy.title, versionLabel: policy.versionLabel, materialID: policy.materialID, status: 'active', note: 'User selected authority', clauses: [clause], baseVersion: policy.version, operationId: 'ui-edit' };
    assert.equal((await post(route, edit, { Authorization: 'Bearer blocked' })).status, 403);
    const saved = await (await post(route, edit)).json();
    assert.equal(saved.data.status, 'active');
    assert.equal(saved.data.actor.type, 'human');
    assert.equal((await (await post(route, edit)).json()).replayed, true);
    assert.equal((await post(route, { ...edit, operationId: 'stale-ui-edit' })).status, 409);
    const history = application.store.history({ entityType: 'policy', entityID: policy.id });
    assert.ok(history.changes.every(item => item.actor.type === 'human'));
    writeFileSync(application.store.material(policy.materialID).path, 'tampered');
    assert.equal((await fetch(base + policy.material.href + '?download=1')).status, 409);
  } finally { await application.close(); cleanup(folder); }
});
