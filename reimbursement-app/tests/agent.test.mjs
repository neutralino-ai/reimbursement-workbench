import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { executeAgentCommand, getAgentCatalog } from '../server/agent.mjs';
import { createApp } from '../server/index.mjs';

function fixture(t) {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-agent-test-'));
  let store = createStore({ dataDir: folder });
  let counter = 0;
  const command = (type, payload, baseVersion, operationId = `test-op-${++counter}`) => ({ type, payload, ...(baseVersion ? { baseVersion } : {}), operationId, actor: { type: 'agent', id: 'test-codex' } });
  const execute = (type, payload, baseVersion, operationId) => executeAgentCommand(store, command(type, payload, baseVersion, operationId));
  const importFile = (role, filename = `${role}.pdf`, content = `synthetic ${role}`, rest = {}) => execute('material.import', { filename, role, contentBase64: Buffer.from(content).toString('base64'), source: { kind: 'user-upload', note: 'Synthetic fixture only' }, ...rest }).data;
  const invoicePayload = (invoiceID, invoiceMaterial) => ({ id: invoiceID, accountID: 'gpt', accountName: 'GPT synthetic', vendor: 'chatgpt', invoiceNumber: invoiceID, date: '2026-01-25', billingMonth: '2026-01', amount: '200.00', currency: 'USD', evidenceIDs: [invoiceMaterial.id] });
  const makeInvoice = () => {
    const invoiceMaterial = importFile('invoice');
    const paymentMaterial = importFile('payment');
    const payload = invoicePayload('invoice-1', invoiceMaterial);
    const record = execute('invoice.upsert', payload, 'new').data;
    return { invoiceMaterial, paymentMaterial, payload, record };
  };
  t.after(() => {
    store.close();
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('reimbursement-agent-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { get store() { return store; }, folder, command, execute, importFile, makeInvoice,
    restart() { store.close(); store = createStore({ dataDir: folder }); return store; } };
}

test('catalog commands validate inputs and agent cannot claim human verification', t => {
  const f = fixture(t);
  assert.ok(getAgentCatalog().some(item => item.name === 'document.register'));
  assert.throws(() => executeAgentCommand(f.store, { type: 'workspace.get', actor: { type: 'human', id: 'pretend' } }), { statusCode: 403 });
  assert.throws(() => f.execute('invoice.upsert', {}, 'new'), { statusCode: 400 });
  assert.throws(() => f.execute('verification.set', {}), { statusCode: 404 });
  const state = executeAgentCommand(f.store, { type: 'workspace.get', actor: { type: 'agent', id: 'test' } });
  assert.equal(state.agent.sync.enabled, false);
});

test('original import is immutable, idempotent across restart, and retains provenance', t => {
  const f = fixture(t);
  const p = { filename: '../unsafe/original.pdf', role: 'invoice', contentBase64: Buffer.from('test original').toString('base64'), source: { kind: 'browser-download', url: 'https://example.test/invoice' } };
  const first = f.execute('material.import', p, undefined, 'persistent-op');
  assert.equal(first.data.filename, 'original.pdf');
  assert.equal(first.data.source.kind, 'browser-download');
  assert.equal(readFileSync(f.store.material(first.data.id).path, 'utf8'), 'test original');
  f.restart();
  const repeated = f.execute('material.import', p, undefined, 'persistent-op');
  assert.equal(repeated.replayed, true);
  assert.equal(f.store.workspace().materials.length, 1);
  assert.throws(() => f.execute('material.import', { ...p, filename: 'other.pdf' }, undefined, 'persistent-op'), { statusCode: 409 });
  assert.throws(() => f.execute('material.import', { ...p, contentBase64: 'not base64' }), { statusCode: 400 });
});

test('agent patches are atomic, preserve unrelated fields, reject stale versions and duplicate invoices', t => {
  const f = fixture(t);
  const { record, paymentMaterial, invoiceMaterial, payload } = f.makeInvoice();
  const payment = f.execute('record.patch', { recordID: record.id, paymentVerified: true, evidenceIDs: [paymentMaterial.id], note: 'Compared merchant, amount and date' }, record.version).data;
  assert.equal(payment.paymentVerified, true);
  assert.equal(payment.claimConfirmed, false);
  assert.equal(payment.humanVerification.status, 'unreviewed');
  assert.throws(() => f.execute('record.patch', { recordID: record.id, claimedCNY: '1400', claimConfirmed: true, evidenceIDs: [invoiceMaterial.id], note: 'Stale patch' }, record.version), { statusCode: 409 });
  const claimed = f.execute('record.patch', { recordID: record.id, claimedCNY: '1400', claimConfirmed: true, evidenceIDs: [invoiceMaterial.id], note: 'Documented exchange rate' }, payment.version).data;
  assert.equal(claimed.paymentVerified, true);
  assert.equal(claimed.claimedCNY, '1400.00');
  assert.throws(() => f.execute('invoice.upsert', { ...payload, id: 'duplicate' }, 'new'), { statusCode: 409 });
  assert.throws(() => f.execute('record.patch', { recordID: record.id, submittedOn: '2026-02-31', evidenceIDs: [paymentMaterial.id], note: 'Invalid date' }, claimed.version), { statusCode: 400 });
  assert.equal(f.store.workspace().records[0].version, claimed.version, 'failure does not bump version');
  const changed = f.execute('invoice.upsert', { ...payload, amount: '210.00' }, claimed.version).data;
  assert.equal(changed.paymentVerified, false, 'invoice financial changes revoke dependent assertions');
  assert.equal(changed.claimConfirmed, false);
});

test('human verification is bound to current facts and becomes stale after agent edits or file tampering', t => {
  const f = fixture(t);
  const { record, invoiceMaterial } = f.makeInvoice();
  const verified = f.store.verifyRecord(record.id, { baseVersion: record.version, evidenceFingerprint: record.evidenceFingerprint, result: 'accepted', note: 'Reviewed evidence' });
  assert.equal(verified.humanVerification.status, 'verified');
  const updated = f.execute('record.patch', { recordID: record.id, submissionReference: 'SYNTHETIC-ARP', evidenceIDs: [invoiceMaterial.id], note: 'Imported submission reference' }, record.version).data;
  assert.equal(updated.humanVerification.status, 'stale');
  assert.throws(() => f.store.verifyRecord(record.id, { baseVersion: record.version, evidenceFingerprint: record.evidenceFingerprint, result: 'accepted', note: 'Old UI' }), { statusCode: 409 });
  const reviewed = f.store.verifyRecord(record.id, { baseVersion: updated.version, evidenceFingerprint: updated.evidenceFingerprint, result: 'accepted', note: 'Reviewed current submission' });
  assert.equal(reviewed.humanVerification.status, 'verified');
  writeFileSync(f.store.material(invoiceMaterial.id).path, 'tampered fixture');
  assert.equal(f.store.workspace().records[0].humanVerification.status, 'stale');
});

test('human verification rejects evidence that changed without a new business record version', t => {
  const f = fixture(t);
  const { record, invoiceMaterial } = f.makeInvoice();
  assert.match(record.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.store.workspace().records[0].evidenceFingerprint, record.evidenceFingerprint, 'repeated reads keep a stable fingerprint');
  assert.throws(() => f.store.verifyRecord(record.id, { baseVersion: record.version, result: 'accepted', note: 'Missing fingerprint' }), { statusCode: 400 });
  assert.throws(() => f.store.verifyRecord(record.id, { baseVersion: record.version, evidenceFingerprint: '0'.repeat(64), result: 'accepted', note: 'Wrong fingerprint' }), { statusCode: 409 });
  writeFileSync(f.store.material(invoiceMaterial.id).path, 'changed after the review screen was opened');
  const changed = f.store.workspace().records[0];
  assert.equal(changed.version, record.version, 'filesystem changes do not increment the ledger version');
  assert.notEqual(changed.evidenceFingerprint, record.evidenceFingerprint);
  for (const result of ['accepted', 'rejected']) {
    assert.throws(() => f.store.verifyRecord(record.id, { baseVersion: record.version, evidenceFingerprint: record.evidenceFingerprint, result, note: 'Stale browser view' }), { statusCode: 409 });
  }
  assert.equal(f.store.workspace().records[0].humanVerification.status, 'unreviewed');
  const current = f.store.verifyRecord(record.id, { baseVersion: changed.version, evidenceFingerprint: changed.evidenceFingerprint, result: 'rejected', note: 'Reopened and found damaged original' });
  assert.equal(current.humanVerification.status, 'rejected');
  assert.equal(current.evidenceFingerprint, changed.evidenceFingerprint, 'recording a human opinion does not change the underlying evidence fingerprint');
  f.restart();
  assert.equal(f.store.workspace().records[0].humanVerification.status, 'rejected');
});

test('ARP evidence and allocation preserve exact limits and idempotency; removing is a history tombstone', t => {
  const f = fixture(t);
  const { record, invoiceMaterial, paymentMaterial } = f.makeInvoice();
  const ready = f.execute('record.patch', { recordID: record.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1400', evidenceIDs: [invoiceMaterial.id, paymentMaterial.id], note: 'Matched complete synthetic invoice/payment facts' }, record.version).data;
  const approval = f.importFile('approval');
  const p = { id: 'arp-1', reimbursementNumber: 'SYNTHETIC-BPT', status: '生成凭证', claimedCNY: '1400', approvedCNY: '1400', approvalVerified: true, evidenceIDs: [approval.id], approvalEvidenceID: approval.id, sourceLabel: 'Synthetic browser observation', observedAt: '2026-09-16T00:00:00Z' };
  const arp = f.execute('arp.upsert', p, 'new').data;
  assert.equal(arp.approvalVerified, true);
  assert.throws(() => f.execute('arp.upsert', { ...p, id: 'arp-duplicate' }, 'new'), { statusCode: 409 });
  const allocationPayload = { recordID: record.id, arpID: arp.id, amountCNY: '1400', basis: 'Explicit invoice-to-ARP item match', evidenceIDs: [approval.id] };
  const allocation = f.execute('allocation.create', allocationPayload, ready.version, 'allocate-once');
  assert.equal(f.execute('allocation.create', allocationPayload, ready.version, 'allocate-once').replayed, true);
  const completed = f.store.workspace().records[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.submissionReference, '', 'approval does not invent a submission');
  assert.equal(completed.humanVerification.status, 'unreviewed');
  assert.throws(() => f.execute('allocation.create', { ...allocationPayload, amountCNY: '0.01' }, completed.version), { statusCode: 409 });
  assert.throws(() => f.execute('arp.upsert', { ...p, approvedCNY: '1300' }, arp.version), { statusCode: 409 });
  f.execute('allocation.remove', { allocationID: allocation.data.id, reason: 'Synthetic correction' }, completed.version);
  const history = executeAgentCommand(f.store, { type: 'history.list', actor: { type: 'agent', id: 'test' }, payload: { entityType: 'allocation', entityID: allocation.data.id } });
  assert.equal(history.changes[0].snapshot.deleted, true);
  assert.equal(history.changes.length, 2);
});

test('registered Word/PDF documents expose provenance and stale sources instead of certifying them', t => {
  const f = fixture(t);
  const { record, invoiceMaterial } = f.makeInvoice();
  const docx = f.importFile('document', 'packet.docx', 'synthetic docx');
  const pdf = f.importFile('document', 'packet.pdf', 'synthetic pdf');
  const p = { id: 'packet-1', title: 'Synthetic claim package', materialIDs: [docx.id, pdf.id], recordIDs: [record.id], sourceRecordVersions: { [record.id]: record.version }, sourceMaterialIDs: [invoiceMaterial.id], status: 'ready', note: 'Rendered and inspected by generating agent' };
  assert.throws(() => f.execute('document.register', { ...p, materialIDs: [docx.id] }, 'new'), { statusCode: 409 });
  const document = f.execute('document.register', p, 'new').data;
  assert.equal(document.stale, false);
  f.execute('record.patch', { recordID: record.id, submissionReference: 'new reference', evidenceIDs: [invoiceMaterial.id], note: 'Updated source after document generation' }, record.version);
  assert.equal(f.store.workspace().documents[0].stale, true);
  assert.throws(() => f.execute('document.register', { ...p, id: 'outdated-packet' }, 'new'), { statusCode: 409 });
});

test('out-of-scope reservations retain original approval amount and prevent reusing December money', t => {
  const f = fixture(t);
  const { record, invoiceMaterial, paymentMaterial, payload } = f.makeInvoice();
  const january = f.execute('record.patch', { recordID: record.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1392.16', evidenceIDs: [invoiceMaterial.id, paymentMaterial.id], note: 'January share from the itemized approval' }, record.version).data;
  const second = f.execute('invoice.upsert', { ...payload, id: 'invoice-feb', invoiceNumber: 'invoice-feb', billingMonth: '2026-02', date: '2026-02-25' }, 'new').data;
  const february = f.execute('record.patch', { recordID: second.id, claimConfirmed: true, claimedCNY: '1392.16', evidenceIDs: [invoiceMaterial.id], note: 'Synthetic second eligible claim' }, second.version).data;
  const proof = f.importFile('approval', 'december-january-items.pdf', 'Synthetic: December 2025 1392.16 and January 2026 1392.16');
  const p = { id: 'arp-mixed-years', reimbursementNumber: 'SYNTHETIC-MIXED-YEARS', status: '生成凭证', claimedCNY: '2784.32', approvedCNY: '2784.32', reservedCNY: '1392.16', reserveReason: 'Itemized original includes December 2025 outside the 2026 ledger; reserve its documented 1392.16 share.', approvalVerified: true, evidenceIDs: [proof.id], approvalEvidenceID: proof.id, sourceLabel: 'Synthetic itemized original', observedAt: '2026-09-16T00:00:00Z' };
  assert.throws(() => f.execute('arp.upsert', { ...p, reserveReason: '' }, 'new'), { statusCode: 409 });
  assert.throws(() => f.execute('arp.upsert', { ...p, reservedCNY: '2784.33' }, 'new'), { statusCode: 409 });
  let arp = f.execute('arp.upsert', p, 'new').data;
  assert.equal(arp.approvedCNY, '2784.32');
  assert.equal(arp.reservedCNY, '1392.16');
  assert.equal(arp.availableCNY, '1392.16');
  assert.match(arp.reserveReason, /December 2025/);
  f.execute('allocation.create', { recordID: january.id, arpID: arp.id, amountCNY: '1392.16', basis: 'January exact invoice line', evidenceIDs: [proof.id] }, january.version);
  arp = f.store.workspace().arpRecords[0];
  assert.equal(arp.availableCNY, '0.00');
  assert.equal(arp.approvedCNY, '2784.32');
  assert.throws(() => f.execute('allocation.create', { recordID: february.id, arpID: arp.id, amountCNY: '0.01', basis: 'Cannot consume reserved December share', evidenceIDs: [proof.id] }, february.version), { statusCode: 409 });
  assert.throws(() => f.execute('arp.upsert', { ...p, reservedCNY: '1392.17' }, arp.version), { statusCode: 409 });
  const { reservedCNY, reserveReason, ...refresh } = p;
  const refreshed = f.execute('arp.upsert', { ...refresh, sourceLabel: 'Updated observation, unchanged reservation' }, arp.version).data;
  assert.equal(refreshed.reservedCNY, '1392.16', 'omitting reservation must not release committed out-of-scope money');
  assert.equal(refreshed.reserveReason, reserveReason);
  assert.equal(refreshed.availableCNY, '0.00');
  f.restart();
  assert.equal(f.store.workspace().arpRecords[0].reservedCNY, '1392.16');
});

test('damaged invoice-to-ARP mapping evidence revokes completion even while approval original remains intact', t => {
  const f = fixture(t);
  const { record, invoiceMaterial, paymentMaterial } = f.makeInvoice();
  const ready = f.execute('record.patch', { recordID: record.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1400', evidenceIDs: [invoiceMaterial.id, paymentMaterial.id], note: 'Synthetic facts' }, record.version).data;
  const approval = f.importFile('approval');
  const mapping = f.importFile('observation', 'specific-invoice-mapping.json', '{"synthetic":"invoice is an exact ARP item"}');
  const arp = f.execute('arp.upsert', { id: 'arp-mapping', reimbursementNumber: 'SYNTHETIC-MAPPING', status: 'approved', claimedCNY: '1400', approvedCNY: '1400', approvalVerified: true, evidenceIDs: [approval.id], approvalEvidenceID: approval.id, sourceLabel: 'Synthetic approval', observedAt: '2026-09-16T00:00:00Z' }, 'new').data;
  const allocation = f.execute('allocation.create', { recordID: ready.id, arpID: arp.id, amountCNY: '1400', basis: 'Exact mapping from separate evidence', evidenceIDs: [mapping.id] }, ready.version).data;
  assert.deepEqual(allocation.evidenceIDs, [mapping.id]);
  assert.equal(f.store.workspace().records[0].status, 'completed');
  writeFileSync(f.store.material(mapping.id).path, 'tampered synthetic mapping');
  const state = f.store.workspace();
  assert.equal(state.arpRecords[0].approvalVerified, true);
  assert.equal(state.records[0].status, 'needs_review');
  assert.equal(state.records[0].approvedCNY, '0.00');
  assert.ok(state.records[0].issues.some(issue => issue.includes('对应证据')));
  assert.equal(state.arpRecords[0].availableCNY, '0.00', 'invalid mapping still reserves allocated money until explicitly corrected');
});

test('authenticated agent HTTP API rejects cross-site requests and cannot invoke human verification', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-agent-http-'));
  const application = await createApp({ dataDir: folder, legacyDir: path.join(folder, 'not-present') });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  try {
    const token = JSON.parse(readFileSync(application.agentConfigPath, 'utf8')).token;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/agent/catalog')).status, 401);
    assert.equal((await fetch(base + '/api/agent/catalog', { headers })).status, 200);
    const c = { type: 'source.update', operationId: 'http-source', actor: { type: 'agent', id: 'http-test' }, payload: { id: 'chatgpt', status: 'blocked', detail: 'Synthetic login required', checkedAt: '2026-09-16T00:00:00Z', evidenceIDs: [] } };
    const response = await fetch(base + '/api/agent/commands', { method: 'POST', headers, body: JSON.stringify(c) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'blocked');
    assert.equal((await fetch(base + '/api/agent/commands', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.test' }, body: JSON.stringify(c) })).status, 403);
    assert.equal((await fetch(base + '/api/records/anything/verify', { method: 'POST', headers: { ...headers, Origin: base }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/agent/commands', { method: 'POST', headers, body: JSON.stringify({ ...c, actor: { type: 'human', id: 'spoof' } }) })).status, 403);
    assert.equal((await fetch(base + '/api/tasks')).status, 200);
  } finally {
    await application.close();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('reimbursement-agent-http-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
