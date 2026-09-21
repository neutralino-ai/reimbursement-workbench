import type { DeliveryItem, DeliveryStatus, GeneratedDocument, Material, RecordItem, Source, Workspace } from './types';

export type WorkflowStepId = 'materials' | 'payment' | 'claim' | 'submission' | 'approval';
export type WorkflowStepState = 'done' | 'todo' | 'attention';
export type WorkflowStep = { id: WorkflowStepId; title: string; shortTitle: string; description: string; actionLabel: string; requirements: string[] };
export type RecordWorkflowStep = { id: WorkflowStepId; state: WorkflowStepState; detail: string };
export type WorkflowContext = Pick<Workspace, 'documents' | 'deliveryItems' | 'materials'>;
export type DeliveryFile = { material: Material; recordIDs: string[]; items: DeliveryItem[]; status: DeliveryStatus; manualStatus: DeliveryStatus; derivedByFinance: boolean; financeRecordIDs: string[]; kind: 'invoice' | 'payment' | 'statement' };

export const workflowSteps: WorkflowStep[] = [
  { id: 'materials', title: '收集原始材料', shortTitle: '原始材料', description: '发票原件与来源采集时间。', actionLabel: '查看原件', requirements: ['有效的发票原件', '来源采集时间在设定期限内'] },
  { id: 'payment', title: '核验实付款', shortTitle: '实付款', description: '沿用已留存的付款凭证，仅补缺少的月份。', actionLabel: '查看付款', requirements: ['有效的实际付款凭证', '人工付款核验另行保留'] },
  { id: 'claim', title: '准备申报材料', shortTitle: '申报材料', description: '发票、付款凭证和正式情况说明。', actionLabel: '准备材料', requirements: ['发票及付款原件', '助手填写情况说明', '有效且未过期的正式申请包'] },
  { id: 'submission', title: '交财务秘书', shortTitle: '交秘书', description: '按文件记录已交、未交或待确认。', actionLabel: '登记交付', requirements: ['逐文件登记交付情况', '交秘书与 ARP 提交分别记录'] },
  { id: 'approval', title: '财务审核', shortTitle: '财务审核', description: '从 ARP 确认财务审核进度。', actionLabel: '查看审核', requirements: ['核对财务审核记录', '全部审核通过即完成报销'] },
];

export function cents(value: unknown): bigint | null {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
}
export function decimal(value: bigint): string { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
export function cny(value: unknown): string { const amount = cents(value); return amount === null ? '待确认' : `¥${decimal(amount)}`; }
/** User rule: verified finance approval closes earlier workflow steps without inventing original files or manual actions. */
export function isFinanceCompleted(record: RecordItem): boolean {
  if (record.status === 'completed') return true;
  const claim = cents(record.claimedCNY), approved = cents(record.approvedCNY);
  return record.claimConfirmed === true && claim !== null && claim > 0n && approved !== null && approved >= claim;
}
/** Pending finance review closes only the first four stages; the backend verifies its mapping and source evidence. */
export function arePriorStepsComplete(record: RecordItem): boolean {
  return isFinanceCompleted(record) || record.financeReviewPending === true;
}
export function validMaterials(record: RecordItem, role: string): Material[] { return (record.materials || []).filter(material => material.role === role && material.integrity === 'ok'); }
export function relatedDocuments(record: RecordItem, context?: WorkflowContext): GeneratedDocument[] { return (context?.documents || []).filter(document => document.recordIDs?.includes(record.id)); }

export function sortWorkflowRecords(records: RecordItem[]): RecordItem[] {
  const dateKey = (record: RecordItem) => /^\d{4}-\d{2}-\d{2}$/.test(record.date || '') && Number.isFinite(Date.parse(record.date)) ? record.date : '';
  return [...records].sort((a, b) => dateKey(b).localeCompare(dateKey(a)) || a.id.localeCompare(b.id));
}

export function getExchangeRateEvidence(record: RecordItem, context?: WorkflowContext): { valid: boolean; screenshots: Material[]; issues: string[] } {
  if (record.currency === 'CNY') return { valid: true, screenshots: [], issues: [] };
  const fact = record.exchangeRate;
  if (!fact) return { valid: false, screenshots: [], issues: ['缺少发票日期的中行折算价截图'] };
  const all = new Map([...(context?.materials || []), ...(record.materials || [])].map(material => [material.id, material]));
  const screenshots = (fact.evidenceIDs || []).map(id => all.get(id)).filter((material): material is Material => !!material && material.role === 'exchangeRate' && material.integrity === 'ok' && /\.(png|jpe?g|webp|gif|heic)$/i.test(material.filename));
  let official = false;
  try { const url = new URL(fact.sourceUrl); official = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && ['boc.cn', 'bankofchina.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); } catch { /* A missing or malformed URL is not a verified source. */ }
  const valid = fact.valid === true && fact.date === record.date && fact.currency === record.currency && fact.provider === 'BOC' && fact.rateType === '中行折算价' && fact.unit === 100 && official
    && screenshots.length > 0 && screenshots.length === new Set(fact.evidenceIDs).size;
  return { valid, screenshots, issues: valid ? [] : fact.issues?.length ? fact.issues : ['汇率日期、官方来源或截图原件需要核对'] };
}

/** Review notes never stand in for a formal application; original evidence and generated output must remain intact. */
export function applicationDocuments(record: RecordItem, context?: WorkflowContext): GeneratedDocument[] {
  const invoices = validMaterials(record, 'invoice'), payments = validMaterials(record, 'payment');
  if (!invoices.length || !payments.length || record.paymentVerified !== true || record.claimConfirmed !== true || (cents(record.claimedCNY) ?? 0n) <= 0n) return [];
  const exchange = getExchangeRateEvidence(record, context);
  if (!exchange.valid || cents(record.claimedCNY) !== cents(record.currency === 'CNY' ? record.amount : record.exchangeRate?.cnyAmount)) return [];
  return relatedDocuments(record, context).filter(document => document.purpose === 'application' && document.status === 'ready' && document.stale === false && document.needsUpdate === false
    && document.materials?.length > 0 && document.materials.every(material => material.integrity === 'ok')
    && document.materials.some(material => material.id === document.submissionPDFMaterialID && document.materialIDs?.includes(material.id) && ['document', 'statement'].includes(material.role) && /\.pdf$/i.test(material.filename))
    && document.materials.some(material => /\.docx$/i.test(material.filename))
    && invoices.some(material => document.sourceMaterialIDs?.includes(material.id)) && payments.some(material => document.sourceMaterialIDs?.includes(material.id))
    && exchange.screenshots.every(material => document.sourceMaterialIDs?.includes(material.id)));
}

export function sourceFreshness(source: Source | undefined, days = 7, now = Date.now()) {
  const threshold = Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7;
  const checked = source?.checkedAt ? Date.parse(source.checkedAt) : NaN;
  const valid = Number.isFinite(checked) && checked <= now;
  return { checkedAt: valid ? source!.checkedAt! : null, fresh: valid && now - checked <= threshold * 86_400_000, days: threshold };
}

/** One physical file has one row, even when an application covers several invoices. DOCX remains an editing source. */
export function deliveryFiles(records: RecordItem[], context?: WorkflowContext): DeliveryFile[] {
  const files = new Map<string, DeliveryFile>();
  for (const record of records) {
    const applications = applicationDocuments(record, context);
    const combined = applications.filter(document => document.batchID);
    const separate = applications.filter(document => document.submissionFormat === 'separate-invoices-v1');
    const candidates = separate.length ? [
      ...(record.materials || []).filter(material => material.role === 'invoice' && separate.some(document => document.sourceMaterialIDs.includes(material.id))),
      ...separate.flatMap(document => document.materials.filter(material => material.id === document.submissionPDFMaterialID)),
    ] : [
      ...(!combined.length ? (record.materials || []).filter(material => ['invoice', 'payment'].includes(material.role) || material.role === 'statement' && !/\.docx$/i.test(material.filename)) : []),
      ...(combined.length ? combined : applications).flatMap(document => document.materials.filter(material => material.id === document.submissionPDFMaterialID)),
    ];
    for (const material of candidates) {
      const stored = context?.deliveryItems?.find(item => item.recordID === record.id && item.materialID === material.id);
      if (stored?.required === false) continue;
      const item: DeliveryItem = stored || { recordID: record.id, materialID: material.id, status: 'unknown', updatedAt: null, version: 'new' };
      const existing = files.get(material.id);
      if (existing) { if (!existing.recordIDs.includes(record.id)) { existing.recordIDs.push(record.id); existing.items.push(item); } }
      else files.set(material.id, { material, recordIDs: [record.id], items: [item], status: item.status, manualStatus: item.status, derivedByFinance: false, financeRecordIDs: [], kind: material.role === 'invoice' ? 'invoice' : material.role === 'payment' ? 'payment' : 'statement' });
    }
  }
  const financeIDs = new Set(records.filter(arePriorStepsComplete).map(record => record.id));
  return [...files.values()].map(file => {
    const financeRecordIDs = file.recordIDs.filter(id => financeIDs.has(id));
    const manualStatus: DeliveryStatus = file.items.every(item => item.status === 'submitted') ? 'submitted' : file.items.every(item => item.status === 'not_submitted') ? 'not_submitted' : 'unknown';
    const status: DeliveryStatus = file.items.every(item => item.status === 'submitted' || financeIDs.has(item.recordID)) ? 'submitted' : financeRecordIDs.length ? 'unknown' : manualStatus;
    return { ...file, status, manualStatus, financeRecordIDs, derivedByFinance: financeRecordIDs.length > 0 };
  });
}

export function approvalSummary(records: RecordItem[]) {
  let approved = 0n, pending = 0n, approvedKnown = 0, pendingKnown = 0, unconfirmed = 0;
  for (const record of records) {
    const allocated = cents(record.approvedCNY);
    if (allocated !== null) { approved += allocated; approvedKnown++; }
    const claim = cents(record.claimedCNY);
    if (record.claimConfirmed !== true || claim === null || claim <= 0n) { unconfirmed++; continue; }
    const outstanding = cents(record.outstandingCNY);
    if (outstanding !== null) { pending += outstanding; pendingKnown++; }
  }
  return { approvedCNY: approvedKnown ? decimal(approved) : null, pendingCNY: pendingKnown ? decimal(pending) : null, unconfirmed, unknownDifference: records.length - pendingKnown };
}

/** Presentation stages report existing evidence; they never change payment, approval or human verification facts. */
export function getRecordWorkflow(record: RecordItem, context?: WorkflowContext): RecordWorkflowStep[] {
  if (isFinanceCompleted(record)) return workflowSteps.map(step => ({ id: step.id, state: 'done', detail: '财务已通过，已报销；按报销规则自动完成此步骤。原文件与实际登记记录保持原样。' }));
  if (record.financeReviewPending === true) return workflowSteps.map(step => ({ id: step.id, state: step.id === 'approval' ? 'todo' : 'done', detail: step.id === 'approval' ? `财务审核中，等待全部审核通过。ARP 单号 ${record.submissionReference}。` : '已进入财务审核，前序步骤自动完成；原件与实际登记记录保持原样。' }));
  const invoices = validMaterials(record, 'invoice'), payments = validMaterials(record, 'payment');
  const invoiceProblem = (record.materials || []).some(material => material.role === 'invoice' && material.integrity !== 'ok');
  const paymentProblem = (record.materials || []).some(material => material.role === 'payment' && material.integrity !== 'ok');
  const applications = applicationDocuments(record, context);
  const exchange = getExchangeRateEvidence(record, context);
  const staleApplication = relatedDocuments(record, context).some(document => document.purpose === 'application' && (document.stale || document.status !== 'ready'));
  const files = deliveryFiles([record], context);
  const delivered = files.filter(file => file.status === 'submitted' && file.material.integrity === 'ok').length;
  const claim = cents(record.claimedCNY), confirmed = record.claimConfirmed === true && claim !== null && claim > 0n;
  return [
    { id: 'materials', state: invoices.length ? 'done' : invoiceProblem ? 'attention' : 'todo', detail: invoices.length ? `已留存 ${invoices.length} 份有效发票原件。` : invoiceProblem ? '发票原件缺失或已改变。' : '待收集发票原件。' },
    { id: 'payment', state: payments.length ? 'done' : paymentProblem ? 'attention' : 'todo', detail: payments.length ? `付款原件已留存，无需重复提供。${record.paymentVerified === true ? '付款事实已核实。' : '付款事实待核对。'}` : paymentProblem ? '付款原件缺失或已改变，请补齐。' : '尚缺实际付款凭证。' },
    { id: 'claim', state: applications.length ? 'done' : staleApplication ? 'attention' : 'todo', detail: applications.length ? '报销说明已备妥，原件与发票日期汇率证据完整。' : !exchange.valid ? `待补发票日期 ${record.date} 的中行折算价截图及报销说明 PDF。` : staleApplication ? '申请包需要更新，不能使用过期或未就绪的版本。' : '待准备报销说明 PDF（含付款与汇率截图），发票原件单独随 ZIP 提交；核对说明不计作申报材料。' },
    { id: 'submission', state: applications.length && files.length && delivered === files.length ? 'done' : 'todo', detail: `${delivered}/${files.length} 份现有交付文件已交财务秘书${applications.length ? '。' : '；正式申请包待准备。'}${record.submissionReference ? `ARP 单号另记为 ${record.submissionReference}。` : ''}` },
    { id: 'approval', state: confirmed && record.status === 'completed' ? 'done' : 'todo', detail: !confirmed ? `申报金额待确认；已关联获批 ${cny(record.approvedCNY)}，最终差额未知。` : `已关联获批 ${cny(record.approvedCNY)}；待批 / 未关联 ${cny(record.outstandingCNY)}。` },
  ];
}

export function getNextStep(record: RecordItem, context?: WorkflowContext): WorkflowStepId | null { return getRecordWorkflow(record, context).find(step => step.state !== 'done')?.id ?? null; }
