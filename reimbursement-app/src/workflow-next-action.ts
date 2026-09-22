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
