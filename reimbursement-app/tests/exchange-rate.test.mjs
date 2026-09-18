import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { convertBOCAmount, isOfficialBOCURL } from '../server/exchange-rate.mjs';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const officialSource = { kind: 'browser-observation', url: 'https://www.boc.cn/sourcedb/whpj/', note: 'Synthetic image fixture only, not an actual exchange quote.' };

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'reimbursement-fx-test-'));
  let store = createStore({ dataDir: directory });
  let sequence = 0;
  const command = (type, payload, baseVersion, operationId = `fx-${++sequence}`) => ({ type, payload, ...(baseVersion ? { baseVersion } : {}), operationId, actor: { type: 'agent', id: 'synthetic-fx-test' } });
  const execute = (type, payload, baseVersion, operationId) => store.executeAgentCommand(command(type, payload, baseVersion, operationId));
  const material = (role, filename, bytes = Buffer.from(`Synthetic ${filename}`), source = { kind: 'user-upload', note: 'Synthetic fixture only.' }) => execute('material.import', { role, filename, contentBase64: bytes.toString('base64'), source }).data;
  const invoicePayload = (id, materialIDs, changes = {}) => ({ id, accountID: 'gpt', accountName: 'Synthetic GPT', vendor: 'chatgpt', invoiceNumber: id, date: '2026-01-25', billingMonth: '2026-01', amount: '200.00', currency: 'USD', evidenceIDs: materialIDs, ...changes });
  const invoice = (id, materialIDs, changes = {}) => execute('invoice.upsert', invoicePayload(id, materialIDs, changes), 'new').data;
  const ratePayload = (record, image, changes = {}) => ({ recordID: record.id, date: record.date, currency: record.currency, provider: 'BOC', rateType: '中行折算价', quotedRate: '700.0000', unit: 100, sourceUrl: officialSource.url, evidenceIDs: [image.id], note: 'Synthetic quote fixture; browser content review belongs to the collecting agent.', ...changes });
  const rate = (record, image, changes = {}) => execute('exchangeRate.set', ratePayload(record, image, changes), record.version).data;
  const confirmed = (record, amount = '1400.00', changes = {}) => execute('record.patch', { recordID: record.id, paymentVerified: true, claimConfirmed: true, claimedCNY: amount, evidenceIDs: record.materials.map(material => material.id), note: 'Synthetic independently confirmed payment and claim.', ...changes }, record.version).data;
  const applicationPayload = (id, record, docx, pdf, changes = {}) => ({ id, title: 'Synthetic combined submission package', purpose: 'application', status: 'ready', materialIDs: [docx.id, pdf.id], submissionPDFMaterialID: pdf.id, recordIDs: [record.id], sourceRecordVersions: { [record.id]: record.version }, sourceMaterialIDs: record.materials.map(material => material.id), note: 'Synthetic PDF fixture; not a real visual QA assertion.', ...changes });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('reimbursement-fx-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { get store() { return store; }, command, execute, material, invoice, invoicePayload, rate, ratePayload, confirmed, applicationPayload,
    restart() { store.close(); store = createStore({ dataDir: directory }); },
  };
}

test('BOC per-100 conversion uses exact decimal half-up rounding and strict official URL boundaries', () => {
  assert.equal(convertBOCAmount('200.00', '703.123456'), '1406.25');
  assert.equal(convertBOCAmount('1.00', '0.500000'), '0.01');
  assert.equal(convertBOCAmount('1.00', '0.499999'), '0.00');
  assert.equal(convertBOCAmount('0.01', '50'), '0.01');
  for (const value of ['0', '-700', '7e2', '700.1234567', '1000001', '700,00']) assert.throws(() => convertBOCAmount('200', value));
  for (const url of ['https://boc.cn/', 'http://www.boc.cn/sourcedb/whpj/', 'https://srh.bankofchina.com/search/whpj/search_cn.jsp']) assert.equal(isOfficialBOCURL(url), true);
  for (const url of ['https://boc.cn.evil.example/', 'https://evilboc.cn/', 'https://boc.cn@evil.example/', 'https://user@boc.cn/', 'file:///boc.cn', 'https://boc.cn:1234/', 'https://example.org/?host=boc.cn']) assert.equal(isOfficialBOCURL(url), false);
});

test('exchangeRate.set is audited, persistent and idempotent without overwriting confirmed/submitted/approved amounts', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const payment = f.material('payment', 'payment.png');
  const proof = f.material('approval', 'arp.pdf');
  let record = f.confirmed(f.invoice('first', [invoice.id, payment.id]), '1400.00', { submissionReference: 'SYNTHETIC-ARP' });
  const arp = f.execute('arp.upsert', { id: 'approved', reimbursementNumber: 'SYNTHETIC-ARP', status: '审批通过', claimedCNY: '1400.00', approvedCNY: '1400.00', approvalVerified: true, evidenceIDs: [proof.id], approvalEvidenceID: proof.id, sourceLabel: 'Synthetic ARP source', observedAt: '2026-09-17T00:00:00Z' }, 'new').data;
  f.execute('allocation.create', { recordID: record.id, arpID: arp.id, amountCNY: '1400.00', basis: 'Synthetic exact invoice mapping', evidenceIDs: [proof.id] }, record.version);
  record = f.store.workspace().records[0];
  const beforeARP = f.store.workspace().arpRecords;
  assert.equal(f.store.agentTasks().tasks.some(task => task.recordID === record.id), false, 'historical approved records do not require rebuilding FX evidence');
  const image = f.material('exchangeRate', 'boc.png', screenshot, officialSource);
  assert.equal(image.imageFormat, 'png');
  const payload = f.ratePayload(record, image, { quotedRate: '700.123456' });
  const result = f.execute('exchangeRate.set', payload, record.version, 'one-fx-observation');
  assert.equal(result.data.exchangeRate.valid, true);
  assert.equal(result.data.exchangeRate.cnyAmount, '1400.25');
  assert.equal(result.data.claimedCNY, '1400.00');
  assert.equal(result.data.submissionReference, 'SYNTHETIC-ARP');
  assert.equal(result.data.approvedCNY, '1400.00');
  assert.equal(result.data.paymentVerified, true);
  assert.equal(result.data.status, 'completed');
  assert.equal(result.data.humanVerification.status, 'unreviewed');
  assert.equal(result.data.exchangeRate.actor.type, 'agent');
  assert.deepEqual(f.store.workspace().arpRecords, beforeARP);
  assert.equal(f.execute('exchangeRate.set', payload, record.version, 'one-fx-observation').replayed, true);
  assert.throws(() => f.execute('exchangeRate.set', { ...payload, quotedRate: '701' }, record.version, 'one-fx-observation'), { statusCode: 409 });
  assert.throws(() => f.execute('exchangeRate.set', payload, record.version), { statusCode: 409 });
  assert.equal(f.store.agentTasks().tasks.some(task => task.recordID === record.id), false);
  assert.match(f.store.history({ entityType: 'record', entityID: record.id }).changes[0].reason, /中行/);
  const current = f.store.workspace().records[0];
  f.restart();
  assert.deepEqual(f.store.workspace().records[0], current);
});

test('FX rejects mismatched dates/currency, unauthenticated provenance, renamed documents and invalid image magic', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const record = f.invoice('first', [invoice.id]);
  const image = f.material('exchangeRate', 'boc.png', screenshot, officialSource);
  for (const changes of [{ date: '2026-01-26' }, { currency: 'EUR' }, { sourceUrl: 'https://boc.cn.evil.example/' }]) assert.throws(() => f.rate(record, image, changes), { statusCode: 409 });
  for (const changes of [{ unit: 1 }, { rateType: '现汇卖出价' }, { quotedRate: '700.1234567' }]) assert.throws(() => f.rate(record, image, changes), { statusCode: 400 });
  const unsuitable = [
    f.material('exchangeRate', 'renamed.png', Buffer.from('{"rate":"700"}'), officialSource),
    f.material('exchangeRate', 'table.json', Buffer.concat([screenshot, Buffer.from('synthetic table wrapper')]), officialSource),
    f.material('observation', 'observation.png', screenshot, officialSource),
    f.material('exchangeRate', 'generated.png', Buffer.concat([screenshot, Buffer.from('generated')]), { kind: 'generated', url: officialSource.url }),
    f.material('exchangeRate', 'unofficial.png', Buffer.concat([screenshot, Buffer.from('unofficial')]), { kind: 'browser-observation', url: 'https://example.org/' }),
  ];
  for (const evidence of unsuitable) assert.throws(() => f.rate(record, evidence), { statusCode: 409 });
  assert.equal(f.store.workspace().records[0].exchangeRate, null);
  assert.equal(f.store.workspace().records[0].version, record.version);
  assert.ok(f.store.agentTasks().tasks.some(task => task.kind === 'exchange_rate' && task.status === 'missing'));
});

test('a ready application needs the explicit combined PDF and invoice-date FX manifest; quote edits expose stale packages and claim differences', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const payment = f.material('payment', 'payment.png');
  const docx = f.material('document', 'statement.docx');
  const pdf = f.material('document', 'combined-submission.pdf');
  let record = f.confirmed(f.invoice('first', [invoice.id, payment.id]));
  const missingFX = f.applicationPayload('missing-fx', record, docx, pdf);
  assert.throws(() => f.execute('document.register', missingFX, 'new'), { statusCode: 409 });
  const draft = f.execute('document.register', { ...missingFX, status: 'draft' }, 'new').data;
  assert.equal(draft.ready, false);
  assert.equal(draft.needsUpdate, true);
  assert.ok(draft.readinessIssues.some(issue => issue.includes('中行')));
  const image = f.material('exchangeRate', 'boc.png', screenshot, officialSource);
  record = f.rate(record, image);
  const payload = f.applicationPayload('ready', record, docx, pdf);
  const { submissionPDFMaterialID, ...withoutCombined } = payload;
  assert.throws(() => f.execute('document.register', withoutCombined, 'new'), { statusCode: 409 });
  assert.throws(() => f.execute('document.register', { ...payload, sourceMaterialIDs: [invoice.id, payment.id] }, 'new'), { statusCode: 409 });
  assert.throws(() => f.execute('document.register', { ...payload, submissionPDFMaterialID: invoice.id }, 'new'), { statusCode: 409 });
  const ready = f.execute('document.register', payload, 'new').data;
  assert.equal(ready.ready, true);
  assert.equal(ready.needsUpdate, false);
  assert.equal(ready.materials.length, 2, 'one explanation DOCX and the combined PDF suffice; no separate explanation PDF is required');
  assert.equal(f.store.agentTasks().tasks.some(task => task.recordID === record.id && ['application', 'exchange_rate'].includes(task.kind)), false);
  const updated = f.rate(record, image, { quotedRate: '700.01' });
  assert.equal(updated.claimedCNY, '1400.00');
  assert.equal(updated.exchangeRate.cnyAmount, '1400.02');
  const old = f.store.workspace().documents.find(document => document.id === 'ready');
  assert.equal(old.stale, true);
  assert.equal(old.needsUpdate, true);
  assert.equal(old.registeredStatus, 'ready');
  assert.equal(old.status, 'draft');
  assert.equal(old.ready, false);
  assert.ok(f.store.agentTasks().tasks.some(task => task.kind === 'exchange_rate' && task.status === 'claim_mismatch'));
  assert.throws(() => f.execute('document.register', f.applicationPayload('mismatch', updated, docx, pdf), 'new'), { statusCode: 409 });
  const renamedDate = f.execute('invoice.upsert', f.invoicePayload(record.id, [invoice.id, payment.id], { date: '2026-01-26' }), updated.version).data;
  assert.equal(renamedDate.exchangeRate.valid, false);
  assert.ok(renamedDate.exchangeRate.issues.some(issue => issue.includes('日期')));
  assert.ok(f.store.agentTasks().tasks.some(task => task.kind === 'exchange_rate' && task.status === 'invalid'));
});

test('FX original damage invalidates current packages without modifying the stored rate; CNY invoices are exempt', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const payment = f.material('payment', 'payment.png');
  const image = f.material('exchangeRate', 'boc.png', screenshot, officialSource);
  const docx = f.material('statement', 'statement.docx');
  const pdf = f.material('document', 'combined.pdf');
  const record = f.rate(f.confirmed(f.invoice('usd', [invoice.id, payment.id])), image);
  f.execute('document.register', f.applicationPayload('usd-application', record, docx, pdf), 'new');
  writeFileSync(f.store.material(image.id).path, 'Synthetic changed screenshot bytes');
  const damaged = f.store.workspace().records.find(item => item.id === record.id);
  assert.equal(damaged.exchangeRate.valid, false);
  assert.equal(damaged.exchangeRate.quotedRate, record.exchangeRate.quotedRate);
  assert.equal(damaged.version, record.version, 'file-integrity failure is visible without silently rewriting a record');
  assert.equal(f.store.workspace().documents[0].needsUpdate, true);
  const cny = f.confirmed(f.invoice('cny', [invoice.id, payment.id], { currency: 'CNY' }), '200.00');
  const ready = f.execute('document.register', f.applicationPayload('cny-application', cny, docx, pdf), 'new').data;
  assert.equal(cny.exchangeRate, null);
  assert.equal(ready.ready, true);
  assert.equal(f.store.agentTasks().tasks.some(task => task.recordID === cny.id && task.kind === 'exchange_rate'), false);
});
