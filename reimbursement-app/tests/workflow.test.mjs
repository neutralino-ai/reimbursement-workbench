import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationDocuments, arePriorStepsComplete, approvalSummary, cents, deliveryFiles, getExchangeRateEvidence, getNextStep, getRecordWorkflow, isFinanceCompleted, sortWorkflowRecords, sourceFreshness, validMaterials, workflowSteps } from '../src/workflow.ts';

const original = (role, integrity = 'ok', id = role, filename = `${id}.pdf`) => ({ id, role, integrity, filename, sha256: 'digest', href: `/api/materials/${id}`, legacyVerified: true });
const record = (changes = {}) => ({
  id: 'gpt-jan', accountID: 'gpt', accountName: 'GPT', vendor: 'chatgpt', plan: 'Pro',
  date: '2026-01-25', billingMonth: '2026-01', invoiceNumber: 'GPT-1', amount: '200.00', currency: 'USD',
  materials: [original('invoice'), original('payment')], paymentVerified: false, claimedCNY: '', claimConfirmed: false,
  submissionReference: '', submittedOn: '', notes: '', approvedCNY: '0.00', outstandingCNY: null, status: 'needs_review', issues: [], ...changes,
});
const fxMaterial = () => original('exchangeRate', 'ok', 'fx', '中国银行2026-01-25.png');
const fxFact = (changes = {}) => ({ date: '2026-01-25', currency: 'USD', provider: 'BOC', rateType: '中行折算价', quotedRate: '696.08', unit: 100, sourceUrl: 'https://www.boc.cn/sourcedb/whpj/', evidenceIDs: ['fx'], cnyAmount: '1392.16', valid: true, issues: [], ...changes });
const readyRecord = (changes = {}) => record({ paymentVerified: true, claimedCNY: '1392.16', claimConfirmed: true, outstandingCNY: '1392.16', exchangeRate: fxFact(), ...changes });
const application = (changes = {}) => ({
  id: 'application-1', purpose: 'application', status: 'ready', stale: false, needsUpdate: false, submissionPDFMaterialID: 'application-pdf', recordIDs: ['gpt-jan'],
  sourceRecords: [{ id: 'gpt-jan', version: 'version-1' }], sourceMaterialIDs: ['invoice', 'payment', 'fx'], materialIDs: ['application-pdf', 'application-word'],
  materials: [original('document', 'ok', 'application-pdf', '正式情况说明.pdf'), original('document', 'ok', 'application-word', '正式情况说明.docx')], ...changes,
});
const context = (changes = {}) => ({ documents: [], materials: [fxMaterial()], deliveryItems: [], ...changes });
const byId = (input, ctx) => Object.fromEntries(getRecordWorkflow(input, ctx).map(step => [step.id, step]));

test('ready combined package delivers one PDF across both records without inventing handover', () => {
  const records=[readyRecord(),readyRecord({id:'gpt-feb'})];
  const doc=application({batchID:'batch',recordIDs:records.map(r=>r.id)});
  const ctx=context({documents:[doc]});
  const files=deliveryFiles(records,ctx);
  assert.equal(files.length,1);assert.equal(files[0].material.id,doc.submissionPDFMaterialID);
  assert.deepEqual(files[0].recordIDs,records.map(r=>r.id));assert.equal(files[0].status,'unknown');
  assert.equal(byId(records[0],ctx).submission.state,'todo');
  assert.equal(deliveryFiles(records,context({documents:[{...doc,stale:true}]})).length,2);
});

test('new-format single and combined packages require statements and referenced invoices, not separate screenshots', () => {
  const jan=readyRecord(),feb=readyRecord({id:'gpt-feb',materials:[original('invoice','ok','invoice-feb'),original('payment','ok','payment-feb')]});
  const doc=application({submissionFormat:'separate-invoices-v1',batchID:'batch',recordIDs:[jan.id,feb.id],sourceMaterialIDs:['invoice','invoice-feb','payment','payment-feb','fx']});
  const ctx=context({documents:[doc]});
  assert.deepEqual(deliveryFiles([jan],ctx).map(f=>f.material.id),['invoice','application-pdf']);
  const files=deliveryFiles([jan,feb],ctx);
  assert.equal(files.length,3);assert.ok(files.every(f=>f.kind!=='payment'&&f.status==='unknown'));
  assert.deepEqual(files.find(f=>f.kind==='statement').recordIDs,[jan.id,feb.id]);
  ctx.deliveryItems=[{recordID:jan.id,materialID:'application-pdf',status:'submitted',version:'saved'}];
  assert.equal(byId(jan,ctx).submission.state,'todo','separate invoice is still owed');
  ctx.deliveryItems.push({recordID:jan.id,materialID:'invoice',status:'submitted',version:'saved'});
  assert.equal(byId(jan,ctx).submission.state,'done');
});

test('financial review completes the first four stages while full approval closes the fifth', () => {
  const input = record({ materials: [], financeReviewPending: true, submissionReference: 'ARP-REVIEW', status: 'submitted' });
  const before = structuredClone(input);
  assert.equal(arePriorStepsComplete(input), true);
  assert.equal(isFinanceCompleted(input), false);
  assert.deepEqual(getRecordWorkflow(input).map(step => step.state), ['done', 'done', 'done', 'done', 'todo']);
  assert.equal(getNextStep(input), 'approval');
  assert.deepEqual(deliveryFiles([input]), []);
  assert.deepEqual(applicationDocuments(input), []);
  assert.deepEqual(input, before, 'inference must not manufacture files, payment facts, delivery or approval');
  const revoked = { ...input, financeReviewPending: false };
  assert.equal(arePriorStepsComplete(revoked), false);
  assert.equal(getNextStep(revoked), 'materials');
  assert.equal(arePriorStepsComplete({ ...revoked, notes: '财务审核中', status: 'submitted' }), false);
  assert.ok(getRecordWorkflow({ ...input, status: 'completed' }).every(step => step.state === 'done'));
});

test('financial review derives delivery but keeps manual file states and unrelated records separate', () => {
  const input = record({ financeReviewPending: true });
  const ctx = context({ deliveryItems: [{ recordID: input.id, materialID: 'invoice', status: 'not_submitted', version: 'manual-v1', updatedAt: null }] });
  const before = structuredClone(ctx);
  const invoice = deliveryFiles([input], ctx).find(file => file.material.id === 'invoice');
  assert.equal(invoice.status, 'submitted');
  assert.equal(invoice.manualStatus, 'not_submitted');
  assert.equal(invoice.derivedByFinance, true);
  assert.deepEqual(invoice.financeRecordIDs, [input.id]);
  const shared = deliveryFiles([input, record({ id: 'other' })], ctx).find(file => file.material.id === 'invoice');
  assert.equal(shared.status, 'unknown');
  assert.deepEqual(ctx, before);
});

test('invoice collection is separate from payment; existing valid historical payment is retained without asserting human verification', () => {
  const input = record();
  const before = structuredClone(input);
  assert.equal(byId(input).materials.state, 'done');
  assert.equal(byId(input).payment.state, 'done');
  assert.match(byId(input).payment.detail, /无需重复提供/);
  assert.match(byId(input).payment.detail, /付款事实待核对/);
  assert.equal(input.paymentVerified, false);
  assert.equal(getNextStep(input), 'claim');
  assert.deepEqual(input, before, 'workflow must not change any financial or verification fact');
  assert.equal(byId(record({ materials: [original('invoice')] })).materials.state, 'done');
  assert.equal(byId(record({ materials: [original('invoice')] })).payment.state, 'todo');
});

test('only valid role-specific originals count, not receipt names, saved payment flags or unrelated changed observations', () => {
  const receipt = original('receipt', 'ok', 'receipt', 'paid-invoice-payment.pdf');
  assert.equal(byId(record({ materials: [receipt], paymentVerified: true })).materials.state, 'todo');
  assert.equal(byId(record({ materials: [receipt], paymentVerified: true })).payment.state, 'todo');
  assert.equal(byId(record({ materials: [original('invoice', 'changed')] })).materials.state, 'attention');
  assert.equal(byId(record({ materials: [original('invoice'), original('payment', 'missing')] })).payment.state, 'attention');
  const input = record({ materials: [original('invoice'), original('payment'), original('observation', 'changed')] });
  assert.equal(byId(input).materials.state, 'done');
  assert.equal(byId(input).payment.state, 'done');
  assert.equal(validMaterials(record({ materials: null }), 'invoice').length, 0);
});

test('eight invoices and six historical payment originals produce separate 8/8 and 6/8 coverage', () => {
  const records = Array.from({ length: 8 }, (_, index) => record({ id: `gpt-${index + 1}`, billingMonth: `2026-${String(index + 1).padStart(2, '0')}`, materials: [original('invoice'), ...(index < 6 ? [original('payment')] : [])] }));
  assert.equal(records.filter(item => validMaterials(item, 'invoice').length).length, 8);
  assert.equal(records.filter(item => validMaterials(item, 'payment').length).length, 6);
  assert.deepEqual(records.filter(item => !validMaterials(item, 'payment').length).map(item => item.billingMonth), ['2026-07', '2026-08']);
});

test('freshness uses only actual source.checkedAt, defaults to seven days and never invents a check time', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(sourceFreshness({ checkedAt: '2026-09-10T12:00:00Z' }, 7, now).fresh, true);
  assert.equal(sourceFreshness({ checkedAt: '2026-09-10T11:59:59Z' }, 7, now).fresh, false);
  assert.equal(sourceFreshness({ checkedAt: '2026-09-09T12:00:00Z' }, 10, now).fresh, true);
  for (const checkedAt of [undefined, '', 'invalid', '2027-01-01T00:00:00Z']) {
    const result = sourceFreshness({ checkedAt, importedAt: '2026-09-17T11:00:00Z' }, 7, now);
    assert.equal(result.fresh, false);
    assert.equal(result.checkedAt, null);
  }
  assert.equal(sourceFreshness(undefined, 0, now).days, 7);
  assert.equal(sourceFreshness(undefined, 366, now).days, 7);
});

test('review notes, draft or stale documents cannot complete the application stage', () => {
  const input = readyRecord();
  for (const change of [{ purpose: 'review' }, { purpose: undefined }, { status: 'draft' }, { stale: true }, { stale: undefined }, { recordIDs: ['another'] }]) {
    const ctx = context({ documents: [application(change)] });
    assert.equal(applicationDocuments(input, ctx).length, 0, JSON.stringify(change));
    assert.notEqual(byId(input, ctx).claim.state, 'done');
  }
  const ctx = context({ documents: [application()] });
  assert.equal(byId(input, ctx).claim.state, 'done');
  assert.equal(byId(input).claim.state, 'todo', 'confirmed money alone does not create an application');
});

test('formal application needs valid originals, both generated formats, current source links and confirmed exact positive claim', () => {
  for (const claimedCNY of ['0', '-1', '1.001', '1e3', '1,000.00', '.50', '1.', '90071992547410.00', '', null]) {
    assert.equal(applicationDocuments(readyRecord({ claimedCNY }), context({ documents: [application()] })).length, 0);
  }
  for (const changes of [{ paymentVerified: false }, { claimConfirmed: false }, { materials: [original('invoice')] }, { materials: [original('invoice'), original('payment', 'changed')] }]) {
    assert.equal(applicationDocuments(readyRecord(changes), context({ documents: [application()] })).length, 0);
  }
  for (const changes of [{ materials: [] }, { materials: [original('document', 'ok', 'only', 'only.pdf')] }, { sourceMaterialIDs: ['invoice'] }, { materials: [original('document', 'changed', 'pdf', 'file.pdf'), original('document', 'ok', 'word', 'file.docx')] }]) {
    assert.equal(applicationDocuments(readyRecord(), context({ documents: [application(changes)] })).length, 0);
  }
  assert.equal(applicationDocuments(readyRecord({ claimedCNY: '0.01', currency: 'CNY', amount: '0.01', exchangeRate: null }), context({ documents: [application()] })).length, 1);
});

test('verified finance completion closes all five stages but preserves the unknown original delivery facts', () => {
  const input = readyRecord({ status: 'completed', approvedCNY: '1392.16', outstandingCNY: '0.00', submissionReference: 'ARP-1', submittedOn: '2026-09-01' });
  const ctx = context({ documents: [application()] });
  const files = deliveryFiles([input], ctx);
  assert.equal(files.length, 3, 'invoice, payment and application PDF; Word is an editing source');
  assert.ok(files.every(file => file.status === 'submitted' && file.derivedByFinance));
  assert.ok(files.every(file => file.manualStatus === 'unknown' && file.items.every(item => item.status === 'unknown')));
  assert.equal(byId(input, ctx).approval.state, 'done');
  assert.equal(byId(input, ctx).submission.state, 'done');
  assert.ok(getRecordWorkflow(input, ctx).every(step => step.state === 'done' && /自动完成/.test(step.detail)));
  assert.equal(getNextStep(input, ctx), null);
});

test('delivery counts only applicable files and never observation JSON, old review documents or editable Word sources', () => {
  const input = readyRecord({ materials: [original('invoice'), original('payment'), original('observation', 'ok', 'obs', 'browser.json'), original('statement', 'ok', 'source', '说明.docx'), original('statement', 'ok', 'statement', '说明.pdf')] });
  const ctx = context({ documents: [application({ purpose: 'review' }), application({ id: 'old', stale: true })] });
  assert.deepEqual(deliveryFiles([input], ctx).map(file => file.material.id), ['invoice', 'payment', 'statement']);
  const excluded = context({ deliveryItems: [{ recordID: input.id, materialID: 'statement', required: false, status: 'submitted', version: 'v1', updatedAt: null }] });
  assert.equal(deliveryFiles([input], excluded).length, 2);
});

test('a shared application PDF is counted once while keeping each record independent delivery version', () => {
  const jan = readyRecord(), feb = readyRecord({ id: 'gpt-feb', materials: [original('invoice', 'ok', 'invoice-feb'), original('payment', 'ok', 'payment-feb')] });
  const doc = application({ recordIDs: [jan.id, feb.id], sourceMaterialIDs: ['invoice', 'payment', 'invoice-feb', 'payment-feb', 'fx'] });
  const deliveries = [
    { recordID: jan.id, materialID: 'application-pdf', status: 'submitted', version: 'delivery-v1', updatedAt: '2026-09-17T10:00:00Z' },
    { recordID: feb.id, materialID: 'application-pdf', status: 'not_submitted', version: 'delivery-v2', updatedAt: '2026-09-17T11:00:00Z' },
  ];
  const ctx = context({ documents: [doc], deliveryItems: deliveries });
  const files = deliveryFiles([jan, feb], ctx);
  assert.equal(files.length, 5);
  const shared = files.find(file => file.material.id === 'application-pdf');
  assert.equal(shared.status, 'unknown');
  assert.deepEqual(shared.items.map(item => item.version), ['delivery-v1', 'delivery-v2']);
  assert.deepEqual(shared.recordIDs, [jan.id, feb.id]);
});

test('all files delivered completes the handoff only while the formal application remains valid', () => {
  const input = readyRecord();
  const ctx = context({ documents: [application()], deliveryItems: ['invoice', 'payment', 'application-pdf'].map(materialID => ({ recordID: input.id, materialID, status: 'submitted', updatedAt: '2026-09-17T10:00:00Z', version: 'v1' })) });
  assert.equal(byId(input, ctx).submission.state, 'done');
  assert.equal(byId(input, { ...ctx, documents: [application({ stale: true })] }).submission.state, 'todo');
  assert.equal(input.submissionReference, '', 'file handoff cannot invent ARP submission facts');
});

test('ARP amounts preserve exact cents, known partial totals and unknown differences separately', () => {
  const records = [readyRecord({ claimedCNY: '100.03', approvedCNY: '40.01', outstandingCNY: '60.02' }), record({ id: 'unknown', claimedCNY: '', approvedCNY: '0.00', outstandingCNY: null })];
  assert.deepEqual(approvalSummary(records), { approvedCNY: '40.01', pendingCNY: '60.02', unconfirmed: 1, unknownDifference: 1 });
  assert.deepEqual(approvalSummary([record()]), { approvedCNY: '0.00', pendingCNY: null, unconfirmed: 1, unknownDifference: 1 });
  assert.deepEqual(approvalSummary([]), { approvedCNY: null, pendingCNY: null, unconfirmed: 0, unknownDifference: 0 });
  assert.match(byId(record()).approval.detail, /最终差额未知/);
  assert.match(byId(records[0]).approval.detail, /¥60\.02/);
  assert.equal(byId(readyRecord({ status: 'submitted', approvedCNY: '1392.16', outstandingCNY: '0.00' })).approval.state, 'done', 'the confirmed claim is covered by verified backend approval allocations');
  assert.equal(cents('90071992547409.91'), 9007199254740991n);
  assert.equal(cents('0.001'), null);
});

test('five steps keep stable drawer IDs with the new task semantics', () => {
  assert.deepEqual(workflowSteps.map(step => step.id), ['materials', 'payment', 'claim', 'submission', 'approval']);
  assert.deepEqual(workflowSteps.map(step => step.title), ['收集原始材料', '核验实付款', '准备申报材料', '交财务秘书', '财务审核']);
  assert.ok(workflowSteps.every(step => step.actionLabel && step.requirements.length));
});

test('finance completion uses derived verified amounts, never notes, filenames or unverified approval flags', () => {
  assert.equal(isFinanceCompleted(record({ status: 'completed' })), true);
  assert.equal(isFinanceCompleted(readyRecord({ approvedCNY: '1392.16' })), true);
  assert.equal(isFinanceCompleted(readyRecord({ approvedCNY: '1392.15' })), false);
  assert.equal(isFinanceCompleted(readyRecord({ approvedCNY: '0.00', notes: '全部审核通过，已报销', approvalVerified: true, submissionReference: 'ARP-1' })), false);
  for (const changes of [{ claimConfirmed: false }, { claimedCNY: '0' }, { claimedCNY: '' }, { claimedCNY: '1.001' }, { approvedCNY: '' }]) {
    assert.equal(isFinanceCompleted(readyRecord({ approvedCNY: '1392.16', ...changes })), false);
  }
});

test('approved records need no replacement documents and become pending again when verified allocation is withdrawn', () => {
  const approved = readyRecord({ materials: [], paymentVerified: false, approvedCNY: '1392.16' });
  const before = structuredClone(approved);
  assert.ok(getRecordWorkflow(approved).every(step => step.state === 'done'));
  assert.deepEqual(deliveryFiles([approved]), [], 'automatic completion does not invent files');
  assert.deepEqual(applicationDocuments(approved), [], 'automatic completion does not invent a formal application');
  assert.deepEqual(approved, before);
  assert.equal(getNextStep({ ...approved, approvedCNY: '0.00' }), 'materials');
});

test('shared files complete only when every associated record is handed over or finance approved', () => {
  const jan = readyRecord({ approvedCNY: '1392.16' }), feb = readyRecord({ id: 'gpt-feb', materials: [original('invoice', 'ok', 'invoice-feb'), original('payment', 'ok', 'payment-feb')] });
  const doc = application({ recordIDs: [jan.id, feb.id], sourceMaterialIDs: ['invoice', 'payment', 'invoice-feb', 'payment-feb', 'fx'] });
  const ctx = context({ documents: [doc] });
  let shared = deliveryFiles([jan, feb], ctx).find(file => file.material.id === 'application-pdf');
  assert.equal(shared.status, 'unknown', 'January approval cannot complete February handoff');
  assert.equal(shared.derivedByFinance, true);
  assert.deepEqual(shared.financeRecordIDs, [jan.id]);
  ctx.deliveryItems = [{ recordID: feb.id, materialID: 'application-pdf', status: 'submitted', updatedAt: null, version: 'v-feb' }];
  shared = deliveryFiles([jan, feb], ctx).find(file => file.material.id === 'application-pdf');
  assert.equal(shared.status, 'submitted');
  assert.equal(shared.manualStatus, 'unknown');
  assert.deepEqual(shared.items.map(item => item.status), ['unknown', 'submitted']);
});

test('overview ordering uses latest invoice date first with stable ID ties and does not mutate source order', () => {
  const records = [record({ id: 'jan', date: '2026-01-25' }), record({ id: 'aug-b', date: '2026-08-25' }), record({ id: 'aug-a', date: '2026-08-25' }), record({ id: 'undated', date: '' })];
  const before = records.map(item => item.id);
  assert.deepEqual(sortWorkflowRecords(records).map(item => item.id), ['aug-a', 'aug-b', 'jan', 'undated']);
  assert.deepEqual(records.map(item => item.id), before);
  assert.deepEqual(sortWorkflowRecords([...records].reverse()).map(item => item.id), ['aug-a', 'aug-b', 'jan', 'undated']);
});

test('foreign currency application needs invoice-date BOC screenshot, exact claim agreement and integrated PDF', () => {
  const ctx = context({ documents: [application()] });
  assert.equal(getExchangeRateEvidence(readyRecord(), ctx).valid, true);
  assert.equal(applicationDocuments(readyRecord(), ctx).length, 1);
  for (const changes of [{ date: '2026-01-24' }, { currency: 'EUR' }, { provider: 'Other' }, { unit: 1 }, { rateType: '现汇卖出价' }, { valid: false }, { sourceUrl: 'https://boc.cn.example.org/rates' }, { sourceUrl: 'https://user@www.boc.cn/rates' }, { sourceUrl: 'https://www.boc.cn:8080/rates' }]) {
    const input = readyRecord({ exchangeRate: fxFact(changes) });
    assert.equal(getExchangeRateEvidence(input, ctx).valid, false, JSON.stringify(changes));
    assert.equal(applicationDocuments(input, ctx).length, 0);
  }
  assert.equal(applicationDocuments(readyRecord({ exchangeRate: null }), ctx).length, 0);
  assert.equal(applicationDocuments(readyRecord({ claimedCNY: '1400.00' }), ctx).length, 0);
  assert.equal(applicationDocuments(readyRecord(), context({ documents: [application({ sourceMaterialIDs: ['invoice', 'payment'] })] })).length, 0);
  for (const changes of [{ needsUpdate: true }, { needsUpdate: undefined }, { submissionPDFMaterialID: undefined }, { submissionPDFMaterialID: 'application-word' }, { submissionPDFMaterialID: 'missing' }]) {
    assert.equal(applicationDocuments(readyRecord(), context({ documents: [application(changes)] })).length, 0, JSON.stringify(changes));
  }
});

test('BOC history URLs and intact supported screenshot formats match the backend evidence contract', () => {
  for (const sourceUrl of ['http://www.boc.cn/rates', 'https://www.bankofchina.com/rates', 'https://boc.cn/rates']) {
    assert.equal(getExchangeRateEvidence(readyRecord({ exchangeRate: fxFact({ sourceUrl }) }), context()).valid, true);
  }
  for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic']) {
    assert.equal(getExchangeRateEvidence(readyRecord(), context({ materials: [original('exchangeRate', 'ok', 'fx', `boc.${extension}`)] })).valid, true);
  }
  for (const material of [original('exchangeRate', 'changed', 'fx', 'boc.png'), original('exchangeRate', 'ok', 'fx', 'boc.pdf'), original('observation', 'ok', 'fx', 'boc.png')]) {
    assert.equal(getExchangeRateEvidence(readyRecord(), context({ materials: [material] })).valid, false);
  }
  assert.equal(getExchangeRateEvidence(readyRecord(), context({ materials: [] })).valid, false);
});

test('CNY requires no conversion screenshot while finance-approved records need no new rate or integrated file', () => {
  const cnyRecord = readyRecord({ currency: 'CNY', amount: '1392.16', exchangeRate: null });
  assert.equal(getExchangeRateEvidence(cnyRecord).valid, true);
  assert.equal(applicationDocuments(cnyRecord, context({ materials: [], documents: [application({ sourceMaterialIDs: ['invoice', 'payment'] })] })).length, 1);
  const approved = readyRecord({ approvedCNY: '1392.16', exchangeRate: null, materials: [] });
  assert.equal(getExchangeRateEvidence(approved).valid, false, 'missing evidence stays missing');
  assert.ok(getRecordWorkflow(approved).every(step => step.state === 'done'), 'finance approval takes priority without inventing exchange-rate evidence');
});
