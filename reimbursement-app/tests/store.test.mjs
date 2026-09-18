import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore, parseMoney, formatMoney } from '../server/store.mjs';

const digest = (content) => createHash('sha256').update(content).digest('hex');
const header = 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By';
const purchase = '01/25/2026,01/26/2026,OPENAI CHATGPT,OpenAI,Software,Purchase,200.00,Owner';
const refund = '01/27/2026,01/28/2026,OPENAI REFUND,OpenAI,Software,Credit,200.00,Owner';
const review = (changes = {}) => ({ claimedCNY: '60.00', paymentVerified: true, claimConfirmed: true, submissionReference: '', submittedOn: '', note: '已核对发票与商户付款日期、金额；确认本笔申报口径。', ...changes });

function fixture(t, { noPayment = false, approvalStatus = '生成凭证' } = {}) {
  const tempRoot = path.resolve(tmpdir());
  const folder = mkdtempSync(path.join(tempRoot, 'reimbursement-store-test-'));
  const legacyDir = path.join(folder, 'legacy');
  const dataDir = path.join(folder, 'data');
  const appData = path.join(legacyDir, 'private-data', 'AppData');
  const materialDir = path.join(appData, 'materials');
  mkdirSync(materialDir, { recursive: true });
  const material = (id, role) => {
    const content = Buffer.from(`original ${id}`);
    const sha256 = digest(content);
    const storedFilename = `${sha256}.pdf`;
    writeFileSync(path.join(materialDir, storedFilename), content);
    return { id, role, filename: `${id}.pdf`, storedFilename, sha256, verified: true };
  };
  const invoice1 = material('invoice-1', 'invoice');
  const payment1 = material('payment-1', 'payment');
  const invoice2 = material('invoice-2', 'invoice');
  const payment2 = material('payment-2', 'payment');
  const approval = material('approval', 'other');
  const observation = material('observation', 'other');
  const raw = {
    accounts: [{ id: 'gpt', name: 'GPT', vendor: 'chatgpt' }, { id: 'claude', name: 'Claude', vendor: 'claude' }],
    records: [
      { id: 'record-1', accountID: 'gpt', amount: '200.00', date: '2026-01-25', billingMonth: '2026-01', currency: 'USD', invoiceNumber: 'GPT-1', materials: noPayment ? [invoice1] : [invoice1, payment1], claimedCNY: '999.00', status: 'completed' },
      { id: 'record-2', accountID: 'gpt', amount: '200.00', date: '2026-02-25', billingMonth: '2026-02', currency: 'USD', invoiceNumber: 'GPT-2', materials: [invoice2, payment2] },
      { id: 'claude-1', accountID: 'claude', amount: '200.00', date: '2026-01-01', billingMonth: '2026-01', currency: 'USD', invoiceNumber: 'CLAUDE-1', materials: [] },
    ],
    inbox: [approval, observation],
    reconciliation: { arpPayments: [
      { id: 'arp-approved', reimbursementNumber: 'BPT1', claimedAmountCNY: '100.00', approvedAmountCNY: '100.00', approvalVerified: true, rawStatus: approvalStatus, sourceReference: `material:${observation.sha256}`, approvalSourceReference: `material:${approval.sha256}` },
      { id: 'arp-approved-2', reimbursementNumber: 'BPT2', claimedAmountCNY: '40.00', approvedAmountCNY: '40.00', approvalVerified: true, rawStatus: '生成凭证', sourceReference: `material:${observation.sha256}`, approvalSourceReference: `material:${approval.sha256}` },
      { id: 'arp-pending', reimbursementNumber: 'BPT3', claimedAmountCNY: '100.00', approvalVerified: false, rawStatus: '财务审核', sourceReference: `material:${observation.sha256}` },
    ] },
  };
  const sourceFile = path.join(appData, 'workspace.json');
  writeFileSync(sourceFile, JSON.stringify(raw));
  const sourceHash = digest(readFileSync(sourceFile));
  let store = createStore({ dataDir, legacyDir });
  t.after(() => {
    store.close();
    assert.equal(digest(readFileSync(sourceFile)), sourceHash, 'original workspace stays unchanged');
    const resolved = path.resolve(folder);
    const relative = path.relative(tempRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(resolved).startsWith('reimbursement-store-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { get store() { return store; }, dataDir, legacyDir, raw, approval, payment1,
    restart() { store.close(); store = createStore({ dataDir, legacyDir }); return store; },
  };
}

test('money parsing is exact and rejects ambiguous numbers', () => {
  assert.equal(parseMoney('2727.8'), 272780);
  assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney('0001.20'), 120);
  assert.equal(formatMoney(parseMoney('-200.1', { signed: true })), '-200.10');
  assert.equal(parseMoney('', { optional: true }), null);
  for (const invalid of ['2e2', '1,000.00', '1.001', 'NaN', '-0.01', '.5', '1.', '90071992547410.00', '', 1.2]) assert.throws(() => parseMoney(invalid), { statusCode: 400 });
  assert.throws(() => parseMoney('0', { positive: true }), { statusCode: 400 });
});

test('legacy import keeps only GPT editable, resets inferred facts and preserves a private snapshot', (t) => {
  const f = fixture(t);
  const state = f.store.workspace();
  assert.equal(state.records.length, 2);
  assert.equal(state.importSummary.accounts, 2);
  assert.equal(state.importSummary.deferredRecords, 1);
  assert.equal(state.records[0].claimedCNY, '');
  assert.equal(state.records[0].claimConfirmed, false);
  assert.equal(state.records[0].paymentVerified, false);
  assert.equal(state.records[0].status, 'needs_review');
  assert.equal(state.allocations.length, 0);
  assert.equal(state.arpRecords.filter((arp) => arp.approvalVerified).length, 2);
  assert.equal(readdirSync(path.join(f.dataDir, 'imports')).filter((name) => name.startsWith('legacy-')).length, 1);
  assert.ok(state.gaps.every((gap) => gap.reason.startsWith('未核查')));
  assert.equal(state.sources.find((source) => source.id === 'arp').url, 'https://ihep.arp.cn');
  assert.throws(() => f.store.reviewRecord('claude-1', review()), { statusCode: 404 });
});

test('restart is idempotent and preserves reviews, allocations and original snapshots', (t) => {
  const f = fixture(t);
  f.store.reviewRecord('record-1', review());
  f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved', amountCNY: '60', basis: '核对报销编号和费用期间' });
  const before = f.store.workspace();
  f.restart();
  const after = f.store.workspace();
  assert.deepEqual(after, before);
  assert.equal(after.records[0].status, 'completed');
  assert.equal(after.records[0].submittedOn, '', 'approval never invents submission date');
  assert.equal(after.records[0].submissionReference, '');
});

test('verified full approval completes the workflow while preserving unverified payment, but requires a confirmed claim', (t) => {
  const f = fixture(t);
  f.store.reviewRecord('record-1', review({ paymentVerified: false }));
  f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved', amountCNY: '60', basis: '明确核对' });
  assert.equal(f.store.workspace().records[0].status, 'completed');
  assert.equal(f.store.workspace().records[0].paymentVerified, false);
  f.store.reviewRecord('record-1', review({ claimConfirmed: false }));
  assert.equal(f.store.workspace().records[0].status, 'needs_review');
  assert.equal(f.store.workspace().records[0].outstandingCNY, null);
  f.store.reviewRecord('record-1', review());
  assert.equal(f.store.workspace().records[0].status, 'completed');
});

test('cannot verify payment with missing payment original or finish from filenames', (t) => {
  const f = fixture(t, { noPayment: true });
  assert.throws(() => f.store.reviewRecord('record-1', review()), { statusCode: 409 });
  assert.equal(f.store.workspace().records[0].paymentVerified, false);
});

test('unverified or pending approval cannot be allocated even if legacy boolean claims approval', (t) => {
  const f = fixture(t, { approvalStatus: '财务审核' });
  f.store.reviewRecord('record-1', review());
  for (const arpID of ['arp-pending', 'arp-approved']) {
    assert.throws(() => f.store.allocate({ recordID: 'record-1', arpID, amountCNY: '10', basis: '核对' }), { statusCode: 409 });
  }
});

test('both sides of many-to-many allocations enforce exact limits', (t) => {
  const f = fixture(t);
  f.store.reviewRecord('record-1', review());
  f.store.reviewRecord('record-2', review());
  const first = f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved', amountCNY: '60', basis: '第一笔' });
  assert.throws(() => f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved-2', amountCNY: '0.01', basis: '记录侧超额' }), { statusCode: 409 });
  assert.throws(() => f.store.allocate({ recordID: 'record-2', arpID: 'arp-approved', amountCNY: '40.01', basis: 'ARP侧超额' }), { statusCode: 409 });
  f.store.allocate({ recordID: 'record-2', arpID: 'arp-approved', amountCNY: '40', basis: '共享一个ARP审批' });
  f.store.allocate({ recordID: 'record-2', arpID: 'arp-approved-2', amountCNY: '20', basis: '同一账单使用第二份审批' });
  assert.equal(f.store.workspace().records[1].status, 'completed');
  assert.throws(() => f.store.reviewRecord('record-1', review({ claimedCNY: '59.99' })), { statusCode: 409 });
  assert.throws(() => f.store.allocate({ recordID: 'record-2', arpID: 'arp-approved', amountCNY: '0', basis: '零' }), { statusCode: 400 });
  f.store.removeAllocation(first.id);
  assert.equal(f.store.workspace().records[0].status, 'ready');
  assert.equal(f.store.workspace().arpRecords.find((arp) => arp.id === 'arp-approved').availableCNY, '60.00');
  assert.ok(f.store.workspace().events.some((event) => event.type === 'allocation_removed'));
});

test('payment original changes revoke payment verification and block serving without undoing valid finance completion', (t) => {
  const f = fixture(t);
  f.store.reviewRecord('record-1', review());
  f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved', amountCNY: '60', basis: '核对完成' });
  const paymentPath = f.store.material('payment-1').path;
  writeFileSync(paymentPath, 'tampered');
  const changed = f.store.workspace().records[0];
  assert.equal(changed.status, 'completed');
  assert.equal(changed.paymentVerified, false);
  assert.equal(changed.materials.find((material) => material.id === 'payment-1').integrity, 'changed');
  assert.throws(() => f.store.material('payment-1'), { statusCode: 409 });
  f.restart();
  assert.equal(f.store.workspace().records[0].status, 'completed');
  assert.equal(f.store.workspace().records[0].paymentVerified, false, 'restart must not silently repair/re-certify changed evidence');
  assert.equal(f.store.workspace().records[0].materials.find((material) => material.id === 'payment-1').integrity, 'changed');
});

test('approval original changes revoke derived approval coverage', (t) => {
  const f = fixture(t);
  f.store.reviewRecord('record-1', review());
  f.store.allocate({ recordID: 'record-1', arpID: 'arp-approved', amountCNY: '60', basis: '核对完成' });
  writeFileSync(f.store.material('approval').path, 'changed approval');
  const state = f.store.workspace();
  assert.equal(state.records[0].status, 'needs_review');
  assert.equal(state.records[0].approvedCNY, '0.00');
  assert.equal(state.records[0].outstandingCNY, '60.00');
  assert.equal(state.arpRecords.find((arp) => arp.id === 'arp-approved').approvalVerified, false);
  assert.equal(state.allocations.length, 1, 'retain historical association for correction');
});

test('review requires explanation, valid dates and explicit facts', (t) => {
  const f = fixture(t);
  for (const changes of [{ note: '' }, { claimedCNY: '' }, { claimedCNY: '0' }, { paymentVerified: 'true' }, { submittedOn: '2026-02-30' }]) {
    assert.throws(() => f.store.reviewRecord('record-1', review(changes)), { statusCode: 400 });
  }
  f.store.reviewRecord('record-1', review({ submissionReference: 'BPT-user-confirmed', submittedOn: '2026-02-28' }));
  assert.equal(f.store.workspace().records[0].status, 'submitted');
});

test('CSV preserves repeated legitimate purchases and credits without confirming payment', (t) => {
  const f = fixture(t);
  const csv = `${header}\n${purchase}\n${purchase}\n${refund}\n01/01/2026,01/02/2026,GROCERIES,Store,Food,Purchase,10,Owner`;
  const result = f.store.importAppleCard({ filename: 'Apple Card.csv', csv });
  assert.equal(result.imported, 3);
  assert.equal(result.ignored, 1);
  const state = f.store.workspace();
  assert.equal(state.cardTransactions.length, 3);
  const credit = state.cardTransactions.find((row) => row.kind === 'credit');
  assert.equal(credit.amount, '-200.00');
  assert.match(credit.description, /退款/);
  assert.deepEqual(credit.candidateRecordIDs, []);
  assert.equal(state.cardTransactions.filter((row) => row.kind === 'purchase').length, 2);
  assert.ok(state.cardTransactions.filter((row) => row.kind === 'purchase').every((row) => row.candidateRecordIDs[0] === 'record-1'));
  assert.equal(state.records[0].paymentVerified, false);
  assert.equal(state.records[0].status, 'needs_review');
  const repeated = f.store.importAppleCard({ filename: 'renamed.csv', csv });
  assert.equal(repeated.alreadyImported, true);
  assert.equal(repeated.imported, 0);
  f.restart();
  assert.equal(f.store.workspace().cardTransactions.length, 3);
  assert.equal(f.store.importAppleCard({ filename: 'again.csv', csv }).imported, 0);
  // A BOM or newline change gives a different source hash, but stable row identity prevents duplication.
  const overlapping = f.store.importAppleCard({ filename: 'overlap.csv', csv: `\ufeff${csv.replaceAll('\n', '\r\n')}\r\n` });
  assert.equal(overlapping.imported, 0);
  assert.equal(overlapping.duplicates, 3);
  assert.equal(f.store.workspace().cardTransactions.length, 3);
});

test('CSV validation is atomic and rejects unknown schema, bad money and impossible dates', (t) => {
  const f = fixture(t);
  const invalidInputs = [
    'Date,Amount\n01/25/2026,200',
    `${header}\n${purchase}\n01/26/2026,01/27/2026,OPENAI,OpenAI,Software,Purchase,12.001,Owner`,
    `${header}\n${purchase}\n02/30/2026,03/01/2026,OPENAI,OpenAI,Software,Purchase,12,Owner`,
  ];
  const originalFiles = readdirSync(path.join(f.dataDir, 'imports'));
  const originalEvents = f.store.workspace().events.length;
  for (const csv of invalidInputs) {
    assert.throws(() => f.store.importAppleCard({ filename: 'bad.csv', csv }), { statusCode: 400 });
    assert.equal(f.store.workspace().cardTransactions.length, 0);
    assert.equal(f.store.workspace().events.length, originalEvents);
    assert.deepEqual(readdirSync(path.join(f.dataDir, 'imports')), originalFiles);
  }
});

test('material retrieval requires a trusted ID and does not accept paths', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.material('../imports/workspace.json'), { statusCode: 404 });
  assert.equal(f.store.material('invoice-1').mime, 'application/pdf');
});
