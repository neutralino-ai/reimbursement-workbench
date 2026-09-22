import type {RecordItem} from './types';
import {getNextStep, isFinanceCompleted, validMaterials, type WorkflowContext, type WorkflowStepId} from './workflow.ts';

/** Mobile navigation only; the authoritative facts and five-step rules are unchanged. */
export function mobileNextAction(record: RecordItem, context: WorkflowContext) {
  const completed = isFinanceCompleted(record);
  let step: WorkflowStepId = getNextStep(record, context) || 'approval';
  // A collected payment file can still need verification before a packet is prepared.
  if (!completed && !record.financeReviewPending && step === 'claim' && !record.paymentVerified) step = 'payment';
  const titles: Record<WorkflowStepId, string> = {
    materials: '收集发票',
    payment: validMaterials(record, 'payment').length ? '核验付款' : '补付款凭证',
    claim: '准备申报材料',
    submission: '确认交财务',
    approval: completed ? '已报销' : record.financeReviewPending ? '财务审核中' : '核对财务审核',
  };
  return {step, title: titles[step], completed, waiting: !completed && record.financeReviewPending === true};
}

export const progressFilters = [
  ['all', '全部进度'],
  ['missing-invoice', '缺发票'],
  ['missing-payment', '缺付款凭证'],
  ['verify-payment', '付款待核验'],
  ['claim', '待准备申报材料'],
  ['submission', '待交财务'],
  ['approval', '待核对财务进度'],
  ['finance-pending', '财务审核中'],
  ['completed', '已报销'],
] as const;
export type ProgressFilter = typeof progressFilters[number][0];

/** Missing-evidence filters include all gaps, even when an earlier step is also missing. */
export function matchesProgress(record: RecordItem, context: WorkflowContext, filter: ProgressFilter) {
  if (filter === 'all') return true;
  const action = mobileNextAction(record, context);
  if (filter === 'completed') return action.completed;
  if (action.completed) return false;
  if (filter === 'finance-pending') return action.waiting;
  if (action.waiting) return false;
  if (filter === 'missing-invoice') return !validMaterials(record, 'invoice').length;
  if (filter === 'missing-payment') return !validMaterials(record, 'payment').length;
  if (filter === 'verify-payment') return !!validMaterials(record, 'payment').length && !record.paymentVerified;
  return action.step === filter;
}
