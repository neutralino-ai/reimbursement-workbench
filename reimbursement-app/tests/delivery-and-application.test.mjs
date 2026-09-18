import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';

function fixture(t) {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-delivery-test-'));
  let store = createStore({ dataDir: folder });
  let counter = 0;
  const command = (type, payload, baseVersion, operationId = `delivery-test-${++counter}`) => ({ type, payload, ...(baseVersion ? { baseVersion } : {}), operationId, actor: { type: 'agent', id: 'synthetic-agent' } });
  const execute = (type, payload, baseVersion, operationId) => store.executeAgentCommand(command(type, payload, baseVersion, operationId));
  const material = (role, filename, content = `Synthetic ${role} ${filename}`) => execute('material.import', { role, filename, contentBase64: Buffer.from(content).toString('base64'), source: { kind: 'user-upload', note: 'Synthetic test original' } }).data;
  const invoice = (id, materialIDs) => execute('invoice.upsert', { id, accountID: 'gpt', accountName: 'Synthetic GPT', vendor: 'chatgpt', invoiceNumber: id, date: '2026-01-25', billingMonth: '2026-01', amount: '200.00', currency: 'USD', evidenceIDs: materialIDs }, 'new').data;
  const withRate = record => {
    const rate = execute('material.import', { filename: 'boc-synthetic.png', role: 'exchangeRate', contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', source: { kind: 'browser-observation', url: 'https://www.boc.cn/sourcedb/whpj/', note: 'Synthetic one-pixel fixture, not a real BOC quote.' } }).data;
    return execute('exchangeRate.set', { recordID: record.id, date: record.date, currency: record.currency, provider: 'BOC', rateType: '中行折算价', quotedRate: '700', unit: 100, sourceUrl: 'https://www.boc.cn/sourcedb/whpj/', evidenceIDs: [rate.id], note: 'Synthetic test-only conversion.' }, record.version).data;
  };
  const document = (id, records, materials, sources, changes = {}) => execute('document.register', { id, title: 'Synthetic situation statement', materialIDs: materials.map(item => item.id), recordIDs: records.map(item => item.id), sourceRecordVersions: Object.fromEntries(records.map(item => [item.id, item.version])), sourceMaterialIDs: sources.map(item => item.id), status: 'ready', note: 'Synthetic generated output', ...changes }, 'new').data;
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('reimbursement-delivery-test-'));
    rmSync(folder, { recursive: true, force: true });
  });
  return { folder, get store() { return store; }, command, execute, material, invoice, document, withRate,
    item(recordID, materialID) { return store.workspace().deliveryItems.find(item => item.recordID === recordID && item.materialID === materialID); },
    restart() { store.close(); store = createStore({ dataDir: folder }); },
  };
}

test('file delivery is independently versioned, persistent and never fabricates ARP or human verification', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const payment = f.material('payment', 'payment.png');
  const unconfirmed = f.invoice('invoice-1', [invoice.id, payment.id]);
  const record = f.withRate(f.execute('record.patch', { recordID: unconfirmed.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1400.00', evidenceIDs: [invoice.id, payment.id], note: 'Synthetic payment and CNY claim evidence checked' }, unconfirmed.version).data);
  const docx = f.material('document', 'statement.docx');
  const pdf = f.material('document', 'statement.pdf');
  const document = f.document('application', [record], [docx, pdf], record.materials, { purpose: 'application', submissionPDFMaterialID: pdf.id });
  const before = f.store.workspace();
  const original = f.item(record.id, invoice.id);
  assert.equal(original.status, 'unknown');
  assert.equal(original.version, 'new');
  assert.equal(original.actor, null);
  const human = f.store.setDelivery(record.id, { materialID: invoice.id, status: 'submitted', baseVersion: original.version });
  assert.equal(human.actor.type, 'human');
  assert.equal(human.status, 'submitted');
  assert.notEqual(human.version, 'new');
  assert.throws(() => f.store.setDelivery(record.id, { materialID: invoice.id, status: 'not_submitted', baseVersion: 'new' }), { statusCode: 409 });
  const p = { recordID: record.id, materialID: invoice.id, status: 'not_submitted', note: 'User explicitly corrected that this file has not been handed to the secretary.' };
  const agent = f.execute('delivery.set', p, human.version, 'one-user-feedback');
  assert.equal(agent.data.actor.type, 'agent');
  assert.equal(f.execute('delivery.set', p, human.version, 'one-user-feedback').replayed, true);
  assert.throws(() => f.execute('delivery.set', { ...p, status: 'submitted' }, human.version, 'one-user-feedback'), { statusCode: 409 });
  const after = f.store.workspace();
  assert.deepEqual(after.records, before.records, 'delivery must not change financial facts, record versions or human verification');
  assert.deepEqual(after.arpRecords, before.arpRecords);
  assert.deepEqual(after.allocations, before.allocations);
  assert.equal(after.documents.find(item => item.id === document.id).stale, false, 'checking delivery does not invalidate the generated application');
  const history = f.store.history({ entityType: 'delivery', entityID: human.id });
  assert.equal(history.changes.length, 2);
  assert.equal(history.changes[0].actor.type, 'agent');
  assert.equal(history.changes[1].actor.type, 'human');
  f.restart();
  assert.deepEqual(f.item(record.id, invoice.id), after.deliveryItems.find(item => item.id === human.id));
});

test('delivery rejects another record files and unregistered, missing or altered originals', t => {
  const f = fixture(t);
  const firstInvoice = f.material('invoice', 'first.pdf');
  const secondInvoice = f.material('invoice', 'second.pdf');
  const first = f.invoice('first', [firstInvoice.id]);
  const second = f.invoice('second', [secondInvoice.id]);
  assert.throws(() => f.store.setDelivery(first.id, { materialID: secondInvoice.id, status: 'submitted', baseVersion: 'new' }), { statusCode: 409 });
  assert.throws(() => f.store.setDelivery(first.id, { materialID: 'unknown-material', status: 'submitted', baseVersion: 'new' }), { statusCode: 409 });
  assert.throws(() => f.execute('delivery.set', { recordID: first.id, materialID: firstInvoice.id, status: 'submitted' }, 'new'), { statusCode: 400 });
  writeFileSync(f.store.material(firstInvoice.id).path, 'changed synthetic original');
  assert.throws(() => f.store.setDelivery(first.id, { materialID: firstInvoice.id, status: 'submitted', baseVersion: 'new' }), { statusCode: 409 });
  assert.equal(f.store.setDelivery(first.id, { materialID: firstInvoice.id, status: 'not_submitted', baseVersion: 'new' }).status, 'not_submitted');
  const missingPath = f.store.material(secondInvoice.id).path;
  assert.equal(path.dirname(missingPath), path.join(f.folder, 'materials'));
  rmSync(missingPath);
  assert.throws(() => f.store.setDelivery(second.id, { materialID: secondInvoice.id, status: 'submitted', baseVersion: 'new' }), { statusCode: 409 });
});

test('application purpose is explicit and ready packages require covered invoice/payment originals', t => {
  const f = fixture(t);
  const firstInvoice = f.material('invoice', 'first-invoice.pdf');
  const firstPayment = f.material('payment', 'first-payment.png');
  const observation = f.material('observation', 'source.json');
  const unconfirmed = f.invoice('first', [firstInvoice.id, firstPayment.id, observation.id]);
  const secondInvoice = f.material('invoice', 'second-invoice.pdf');
  const second = f.invoice('second', [secondInvoice.id]);
  const docx = f.material('document', 'explanation.docx');
  const pdf = f.material('document', 'explanation.pdf');
  assert.throws(() => f.document('unconfirmed-facts', [unconfirmed], [docx, pdf], [firstInvoice, firstPayment], { purpose: 'application' }), { statusCode: 409 });
  const draft = f.document('unconfirmed-draft', [unconfirmed], [docx, pdf], [firstInvoice, firstPayment], { purpose: 'application', status: 'draft' });
  assert.equal(draft.status, 'draft');
  assert.equal(f.item(unconfirmed.id, pdf.id).required, false, 'an unfinished application is not a required delivery item');
  const first = f.withRate(f.execute('record.patch', { recordID: unconfirmed.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1400.00', evidenceIDs: [firstInvoice.id, firstPayment.id], note: 'Synthetic payment and CNY claim confirmed before package generation' }, unconfirmed.version).data);
  const oldReview = f.document('review-default', [first], [docx, pdf], [firstInvoice]);
  assert.equal(oldReview.purpose, 'review');
  const reviewOnlyPDF = f.material('document', 'review-only.pdf');
  f.document('review-only', [first], [docx, reviewOnlyPDF], [firstInvoice]);
  assert.equal(f.item(first.id, reviewOnlyPDF.id).required, false, 'a previous review document is not an application package');
  assert.equal(f.item(first.id, observation.id).required, false);
  assert.throws(() => f.document('missing-payment-source', [first], [docx, pdf], [firstInvoice], { purpose: 'application' }), { statusCode: 409 });
  assert.throws(() => f.document('uncovered-record', [first, second], [docx, pdf], [firstInvoice, firstPayment, secondInvoice], { purpose: 'application' }), { statusCode: 409 });
  assert.throws(() => f.document('missing-word', [first], [pdf], [firstInvoice, firstPayment], { purpose: 'application' }), { statusCode: 409 });
  assert.throws(() => f.document('invoice-not-explanation', [first], [docx, firstInvoice], [firstInvoice, firstPayment], { purpose: 'application' }), { statusCode: 409 });
  const application = f.document('application', [first], [docx, pdf], first.materials, { purpose: 'application', submissionPDFMaterialID: pdf.id });
  assert.equal(application.purpose, 'application');
  assert.equal(f.item(first.id, pdf.id).required, true);
  assert.equal(f.item(first.id, docx.id).required, false, 'Word is an editable source, not automatically mandatory delivery');
  assert.equal(f.item(first.id, firstInvoice.id).required, true);
  assert.equal(f.item(first.id, firstPayment.id).required, true);
  assert.equal(f.store.setDelivery(first.id, { materialID: pdf.id, status: 'submitted', baseVersion: 'new' }).status, 'submitted');
  assert.throws(() => f.store.setDelivery(second.id, { materialID: pdf.id, status: 'submitted', baseVersion: 'new' }), { statusCode: 409 });
  writeFileSync(f.store.material(firstPayment.id).path, 'damaged payment original');
  assert.throws(() => f.document('damaged-source', [first], [docx, pdf], [firstInvoice, firstPayment], { purpose: 'application' }), { statusCode: 409 });
});

test('user upload validates record/version and preserves payment and ARP facts', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const record = f.invoice('first', [invoice.id]);
  const p = { filename: 'card-payment.png', role: 'payment', contentBase64: Buffer.from('Synthetic uploaded payment screenshot').toString('base64'), baseVersion: record.version };
  assert.throws(() => f.store.importRecordMaterial('missing-record', p), { statusCode: 404 });
  assert.throws(() => f.store.importRecordMaterial(record.id, { ...p, baseVersion: 'new' }), { statusCode: 409 });
  assert.throws(() => f.store.importRecordMaterial(record.id, { ...p, role: 'observation' }), { statusCode: 400 });
  assert.throws(() => f.store.importRecordMaterial(record.id, { ...p, filename: 'not-an-image.csv' }), { statusCode: 400 });
  assert.throws(() => f.store.importRecordMaterial(record.id, { ...p, actor: { type: 'agent', id: 'spoof' } }), { statusCode: 400 });
  const uploaded = f.store.importRecordMaterial(record.id, p);
  assert.equal(uploaded.integrity, 'ok');
  assert.equal(uploaded.source.kind, 'user-upload');
  const after = f.store.workspace();
  assert.equal(after.records[0].version, uploaded.recordVersion);
  assert.equal(after.records[0].paymentVerified, false);
  assert.equal(after.records[0].claimConfirmed, false);
  assert.equal(after.records[0].submissionReference, '');
  assert.equal(after.records[0].lastModified.actor.type, 'human');
  assert.equal(after.records[0].humanVerification.status, 'unreviewed');
  assert.equal(after.allocations.length, 0);
  assert.throws(() => f.store.importRecordMaterial(record.id, p), { statusCode: 409 });
  const duplicate = f.store.importRecordMaterial(record.id, { ...p, baseVersion: uploaded.recordVersion });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recordVersion, uploaded.recordVersion, 're-uploading an already attached original does not change the record version');
});

test('tasks expose application and per-file secretary feedback independently of ARP', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'invoice.pdf');
  const payment = f.material('payment', 'payment.png');
  const raw = f.invoice('first', [invoice.id, payment.id]);
  const list = () => f.store.agentTasks().tasks.filter(task => task.recordID === raw.id);
  assert.equal(list().find(task => task.kind === 'application').status, 'missing');
  assert.equal(list().filter(task => task.kind === 'delivery').length, 2);
  f.store.setDelivery(raw.id, { materialID: invoice.id, status: 'submitted', baseVersion: 'new' });
  assert.equal(list().filter(task => task.kind === 'delivery').length, 1);
  assert.ok(list().some(task => task.kind === 'submission'), 'secretary delivery is not an ARP submission');
  const record = f.withRate(f.execute('record.patch', { recordID: raw.id, paymentVerified: true, claimConfirmed: true, claimedCNY: '1400.00', evidenceIDs: [invoice.id, payment.id], note: 'Synthetic confirmed payment and claim' }, raw.version).data);
  const docx = f.material('document', 'statement.docx');
  const pdf = f.material('document', 'statement.pdf');
  f.document('application', [record], [docx, pdf], record.materials, { purpose: 'application', submissionPDFMaterialID: pdf.id });
  assert.equal(list().some(task => task.kind === 'application'), false);
  assert.ok(list().some(task => task.kind === 'delivery' && task.materialID === pdf.id));
  const duplicate = f.execute('material.import', { filename: 'payment.png', role: 'payment', contentBase64: Buffer.from('Synthetic payment payment.png').toString('base64'), source: { kind: 'user-upload' }, recordID: record.id }, record.version).data;
  assert.equal(duplicate.recordVersion, record.version);
  assert.equal(f.store.workspace().documents[0].stale, false, 'duplicate original does not invalidate a prepared application');
  f.execute('record.patch', { recordID: record.id, claimedCNY: '1401.00', evidenceIDs: [invoice.id, payment.id], note: 'Synthetic claim correction' }, record.version);
  assert.equal(list().find(task => task.kind === 'application').status, 'stale');
  assert.equal(f.item(record.id, pdf.id).required, false, 'an obsolete application is not required for current delivery');
});

test('evidence-backed financial review completes exactly four steps without altering facts or user delivery feedback', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'shared-finance-review-invoice.pdf');
  const raw = f.invoice('financial-review-record', [invoice.id]);
  const unrelated = f.invoice('unrelated-record', [invoice.id]);
  const proof = f.material('observation', 'financial-review-observation.json');
  const linked = f.execute('record.patch', { recordID: raw.id, submissionReference: 'SYNTHETIC-IN-FINANCE', evidenceIDs: [proof.id], note: 'Synthetic exact invoice match to observed submission.' }, raw.version).data;
  const delivery = f.store.setDelivery(raw.id, { materialID: invoice.id, status: 'not_submitted', baseVersion: 'new', note: 'Earlier actual user feedback stays intact.' });
  const before = f.store.history({ entityType: 'record', entityID: raw.id });
  const observation = { id: 'in-finance', reimbursementNumber: 'SYNTHETIC-IN-FINANCE', status: '财务审核进行中', claimedCNY: '1400.00', approvalVerified: false, evidenceIDs: [proof.id], sourceLabel: 'Synthetic observed ARP detail', observedAt: '2026-09-17T00:00:00Z' };
  f.execute('arp.upsert', observation, 'new');
  const record = f.store.workspace().records.find(record => record.id === raw.id);
  assert.equal(record.financeReviewPending, true);
  assert.equal(record.priorStepsComplete, true);
  assert.equal(record.financeReviewARPId, 'in-finance');
  assert.deepEqual(record.financeReviewEvidenceIDs, [proof.id]);
  assert.equal(record.status, 'submitted');
  assert.equal(record.approvedCNY, '0.00');
  assert.equal(record.claimedCNY, '');
  assert.equal(record.claimConfirmed, false);
  assert.equal(record.paymentVerified, false);
  assert.equal(record.exchangeRate, null);
  assert.equal(record.humanVerification.status, 'unreviewed');
  assert.equal(record.submittedOn, '', 'inference never invents a submission date');
  assert.equal(record.version, linked.version);
  assert.ok(record.issues.some(issue => issue.includes('付款')), 'raw evidence gaps remain visible to audit');
  assert.deepEqual(f.store.history({ entityType: 'record', entityID: raw.id }), before, 'reading/inference does not rewrite record history');
  const tasks = f.store.agentTasks();
  assert.deepEqual(tasks.tasks.filter(task => task.recordID === raw.id).map(task => [task.kind, task.status]), [['approval', 'pending_approval']]);
  assert.deepEqual(tasks.financeReviewPendingRecordIDs, [raw.id]);
  assert.deepEqual(tasks.priorStepsCompleteRecordIDs, [raw.id]);
  assert.deepEqual(tasks.completedByApprovalRecordIDs, []);
  const item = f.item(raw.id, invoice.id);
  assert.equal(item.status, 'not_submitted');
  assert.equal(item.effectiveStatus, 'submitted');
  assert.equal(item.completedByFinance, true);
  assert.equal(item.completedByApproval, false);
  assert.equal(item.version, delivery.version);
  assert.deepEqual(item.actor, delivery.actor);
  assert.equal(f.item(unrelated.id, invoice.id).effectiveStatus, 'unknown', 'sharing a file is not a submission mapping');
  f.restart();
  assert.equal(f.store.workspace().records.find(record => record.id === raw.id).financeReviewPending, true);

  f.execute('record.patch', { recordID: raw.id, submissionReference: '', evidenceIDs: [proof.id], note: 'Synthetic correction removes the incorrect invoice mapping.' }, linked.version);
  assert.equal(f.store.workspace().records.find(record => record.id === raw.id).financeReviewPending, false);
  assert.equal(f.item(raw.id, invoice.id).effectiveStatus, 'not_submitted');
  assert.ok(f.store.agentTasks().tasks.some(task => task.recordID === raw.id && task.kind === 'application'));
});

test('financial review inference needs an exact mapping, current explicit stage and intact dated observation', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'review-status-invoice.pdf');
  const raw = f.invoice('review-status-record', [invoice.id]);
  const proof = f.material('observation', 'review-status-observation.json');
  f.execute('record.patch', { recordID: raw.id, submissionReference: 'SYNTHETIC-STAGES', evidenceIDs: [proof.id], note: 'Synthetic exact invoice mapping.' }, raw.version);
  const observation = { id: 'review-stages', reimbursementNumber: 'SYNTHETIC-STAGES', status: '财务审核', claimedCNY: '1400.00', approvalVerified: false, evidenceIDs: [proof.id], sourceLabel: 'Synthetic observed ARP detail', observedAt: '2026-09-17T00:00:00Z' };
  let arpVersion = 'new';
  const set = updates => {
    arpVersion = f.execute('arp.upsert', { ...observation, ...updates }, arpVersion).data.version;
    return f.store.workspace().records.find(record => record.id === raw.id);
  };
  for (const status of ['财务审核', '财务审核中', '财务审核进行中', '财务审批中', '当前环节：财务审核中']) {
    assert.equal(set({ status }).financeReviewPending, true, status);
  }
  for (const status of ['审核中', '部门审核中', '部门审核通过', '财务审核未通过', '财务审核通过', '财务审核退回', '已撤销', '未进入财务审核', '已提交', '财务审核中，已退回']) {
    assert.equal(set({ status }).financeReviewPending, false, status);
    assert.ok(f.store.agentTasks().tasks.some(task => task.recordID === raw.id && task.kind === 'application'));
  }
  assert.equal(set({ observedAt: 'unknown' }).financeReviewPending, false, 'an undated assertion is not an observed financial-review state');
  assert.equal(set({ hasUnresolvedAdjustment: true }).financeReviewPending, false, 'unresolved changes block inference');
  assert.equal(set({ reimbursementNumber: 'DIFFERENT-NUMBER' }).financeReviewPending, false, 'similar status/amount does not replace exact mapping');
  assert.equal(set({}).financeReviewPending, true);
  writeFileSync(f.store.material(proof.id).path, 'Changed synthetic observation');
  const invalidated = f.store.workspace().records.find(record => record.id === raw.id);
  assert.equal(invalidated.financeReviewPending, false);
  assert.equal(invalidated.priorStepsComplete, false);
  assert.deepEqual(invalidated.financeReviewEvidenceIDs, []);
  const reopened = f.store.agentTasks().tasks.filter(task => task.recordID === raw.id);
  assert.ok(reopened.some(task => task.kind === 'workflow'));
  assert.ok(reopened.some(task => task.kind === 'exchange_rate'));
  assert.ok(reopened.some(task => task.kind === 'application'));
  assert.ok(reopened.some(task => task.kind === 'delivery'));
  assert.ok(reopened.some(task => task.kind === 'human_verification'));
});

test('verified full ARP coverage completes prerequisite tasks without changing facts and revokes on evidence loss', t => {
  const f = fixture(t);
  const invoice = f.material('invoice', 'shared-invoice.pdf');
  const raw = f.invoice('approved-record', [invoice.id]);
  const other = f.invoice('still-pending-record', [invoice.id]);
  const claimed = f.execute('record.patch', { recordID: raw.id, claimConfirmed: true, claimedCNY: '1400.00', evidenceIDs: [invoice.id], note: 'Synthetic documented CNY claim; independent payment proof is still absent.' }, raw.version).data;
  const delivery = f.store.setDelivery(raw.id, { materialID: invoice.id, status: 'not_submitted', baseVersion: 'new', note: 'Synthetic prior user feedback' });
  const proof = f.material('approval', 'finance-approval.pdf');
  const mapping = f.material('observation', 'exact-mapping.json');
  const arpPayload = { id: 'arp-approval', reimbursementNumber: 'SYNTHETIC-APPROVAL', status: '财务审核', claimedCNY: '1400.00', approvedCNY: '1400.00', approvalVerified: false, evidenceIDs: [proof.id], approvalEvidenceID: proof.id, sourceLabel: 'Synthetic official finance evidence', observedAt: '2026-09-17T00:00:00Z' };
  const pending = f.execute('arp.upsert', arpPayload, 'new').data;
  const tasksFor = () => f.store.agentTasks().tasks.filter(task => task.recordID === raw.id);
  assert.ok(tasksFor().some(task => task.kind === 'application'), 'unlinked finance review does not complete prior steps');
  assert.notEqual(f.store.workspace().records.find(record => record.id === raw.id).status, 'completed');
  assert.equal(f.item(raw.id, invoice.id).effectiveStatus, 'not_submitted');
  const approved = f.execute('arp.upsert', { ...arpPayload, status: '审批通过', approvalVerified: true }, pending.version).data;
  f.execute('allocation.create', { recordID: raw.id, arpID: approved.id, amountCNY: '700.00', basis: 'Synthetic exact first approved share', evidenceIDs: [mapping.id] }, claimed.version);
  assert.ok(tasksFor().some(task => task.kind === 'workflow'), 'partial approval does not complete prior steps');
  const partial = f.store.workspace().records.find(record => record.id === raw.id);
  assert.notEqual(partial.status, 'completed', 'partial approval does not complete the API record status');
  f.execute('allocation.create', { recordID: raw.id, arpID: approved.id, amountCNY: '700.00', basis: 'Synthetic exact remaining approved share', evidenceIDs: [mapping.id] }, partial.version);
  const beforeRead = f.store.workspace();
  const record = beforeRead.records.find(record => record.id === raw.id);
  assert.equal(record.status, 'completed', 'valid full finance approval completes the API record status');
  assert.ok(record.issues.some(issue => issue.includes('付款')), 'original evidence gaps remain available for audit');
  assert.equal(record.paymentVerified, false);
  assert.equal(record.humanVerification.status, 'unreviewed');
  assert.equal(record.submissionReference, '');
  assert.equal(record.materials.some(material => material.role === 'payment'), false);
  assert.deepEqual(tasksFor(), [], 'full verified approval satisfies all prerequisite tasks');
  assert.deepEqual(f.store.agentTasks().completedByApprovalRecordIDs, [raw.id]);
  const completedDelivery = f.item(raw.id, invoice.id);
  assert.equal(completedDelivery.status, 'not_submitted', 'original user feedback is retained');
  assert.equal(completedDelivery.effectiveStatus, 'submitted');
  assert.equal(completedDelivery.completedByApproval, true);
  assert.equal(completedDelivery.version, delivery.version);
  assert.deepEqual(completedDelivery.actor, delivery.actor);
  assert.equal(f.item(other.id, invoice.id).effectiveStatus, 'unknown', 'a shared file does not transfer approval between records');
  assert.deepEqual(f.store.workspace().records, beforeRead.records, 'reading derived completion never mutates financial or verification facts');
  assert.equal(f.store.history({ entityType: 'delivery', entityID: delivery.id }).changes.length, 1);
  writeFileSync(f.store.material(mapping.id).path, 'Synthetic altered mapping evidence');
  assert.equal(f.store.workspace().arpRecords[0].approvalVerified, true, 'the ARP approval itself remains valid while its invoice mapping is revoked');
  assert.equal(f.store.workspace().records.find(record => record.id === raw.id).approvedCNY, '0.00');
  assert.equal(f.store.workspace().records.find(record => record.id === raw.id).status, 'needs_review');
  const reopened = tasksFor();
  assert.ok(reopened.some(task => task.kind === 'workflow'));
  assert.ok(reopened.some(task => task.kind === 'application'));
  assert.ok(reopened.some(task => task.kind === 'delivery'));
  assert.ok(reopened.some(task => task.kind === 'human_verification'));
  assert.equal(f.item(raw.id, invoice.id).completedByApproval, false);
  assert.equal(f.item(raw.id, invoice.id).effectiveStatus, 'not_submitted');
  assert.equal(f.item(raw.id, invoice.id).version, delivery.version);
  assert.deepEqual(f.store.agentTasks().completedByApprovalRecordIDs, []);
});

test('UI delivery and upload routes enforce same-origin and do not accept an agent token as a human identity', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'reimbursement-delivery-http-'));
  const application = await createApp({ dataDir: folder, legacyDir: path.join(folder, 'no-legacy') });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  try {
    const material = application.store.executeAgentCommand({ type: 'material.import', actor: { type: 'agent', id: 'fixture' }, operationId: 'file', payload: { filename: 'invoice.pdf', role: 'invoice', contentBase64: Buffer.from('Synthetic invoice').toString('base64'), source: { kind: 'user-upload' } } }).data;
    const record = application.store.executeAgentCommand({ type: 'invoice.upsert', actor: { type: 'agent', id: 'fixture' }, operationId: 'invoice', baseVersion: 'new', payload: { id: 'first', accountID: 'gpt', accountName: 'Synthetic GPT', vendor: 'chatgpt', invoiceNumber: 'TEST-1', date: '2026-01-25', billingMonth: '2026-01', amount: '200', currency: 'USD', evidenceIDs: [material.id] } }).data;
    const body = JSON.stringify({ materialID: material.id, status: 'submitted', baseVersion: 'new' });
    assert.equal((await fetch(base + '/api/records/first/delivery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    const token = JSON.parse(readFileSync(application.agentConfigPath, 'utf8')).token;
    assert.equal((await fetch(base + '/api/records/first/delivery', { method: 'POST', headers: { Origin: base, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body })).status, 403);
    const delivered = await fetch(base + '/api/records/first/delivery', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).actor.type, 'human');
    const upload = await fetch(base + '/api/records/first/materials', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'payment.png', role: 'payment', contentBase64: Buffer.from('Synthetic payment').toString('base64'), baseVersion: record.version }) });
    assert.equal(upload.status, 200);
    assert.equal(application.store.workspace().records[0].paymentVerified, false);
  } finally {
    await application.close();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('reimbursement-delivery-http-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
