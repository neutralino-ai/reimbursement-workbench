import type {ClaimBatch,RecordItem,Workspace} from './types';

export const cents=(value:string)=>/^\d+(\.\d{1,2})?$/.test(value)?BigInt(value.split('.')[0])*100n+BigInt((value.split('.')[1]||'').padEnd(2,'0')):null;
export const decimal=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
export function batchAmounts(records:RecordItem[]) {
  const amounts=records.map(r=>r.currency==='CNY'?r.amount:r.exchangeRate?.valid?r.exchangeRate.cnyAmount:null);
  const values=amounts.map(a=>a===null?null:cents(a));
  const total=values.every(v=>v!==null)?values.reduce<bigint>((a,b)=>a+(b??0n),0n):null;
  return {amounts,total,totalCNY:total===null?null:decimal(total),overLimit:total!==null&&total>400000n};
}
export function lockedForBatch(record:RecordItem,data:Workspace) {
  return !!(record.priorStepsComplete||record.financeReviewPending||record.status==='completed'||record.submissionReference||record.submittedOn||(cents(record.approvedCNY||'0')??0n)>0n||data.deliveryItems?.some(i=>i.recordID===record.id&&i.status==='submitted'));
}
export function activeBatches(data:Workspace):ClaimBatch[]{return(data.claimBatches||[]).filter(b=>b.status!=='archived');}
export function batchTitle(records:RecordItem[]) {
  const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
  const currency=sorted[0]?.currency||'';
  const months=[...new Set(sorted.map(r=>r.billingMonth))].join(' / ');
  const original=sorted.reduce((sum,r)=>sum+(cents(r.amount)||0n),0n);
  return `${months} · ${currency} ${decimal(original)}`;
}
