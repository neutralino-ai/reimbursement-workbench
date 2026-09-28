import type {ClaimBatch,RecordItem,Workspace} from './types';
import {applicationDocuments,arePriorStepsComplete,getExchangeRateEvidence,getRecordWorkflow,isFinanceCompleted,validMaterials} from './workflow.ts';

export const cents=(value:string)=>/^\d+(\.\d{1,2})?$/.test(value)?BigInt(value.split('.')[0])*100n+BigInt((value.split('.')[1]||'').padEnd(2,'0')):null;
export const decimal=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
export function batchAmounts(records:RecordItem[]) {
  const amounts=records.map(r=>r.currency==='CNY'?r.amount:r.exchangeRate?.valid?r.exchangeRate.cnyAmount:null);
  const values=amounts.map(a=>a===null?null:cents(a));
  const total=values.every(v=>v!==null)?values.reduce<bigint>((a,b)=>a+(b??0n),0n):null;
  return {amounts,total,totalCNY:total===null?null:decimal(total),overLimit:total!==null&&total>400000n};
}
export function lockedForBatch(record:RecordItem,data:Workspace) {
  return !!(record.priorStepsComplete||arePriorStepsComplete(record)||record.status==='submitted'||record.status==='partial'||record.submissionReference||record.submittedOn||(cents(record.approvedCNY||'0')??0n)>0n||data.deliveryItems?.some(i=>i.recordID===record.id&&i.status==='submitted'));
}
export function activeBatches(data:Workspace):ClaimBatch[]{return(data.claimBatches||[]).filter(b=>b.status!=='archived');}
/** Eligibility is a view of the existing single-record workflow, not a new business fact. */
function selectableAmount(record:RecordItem,data:Workspace):bigint|null{
  if(lockedForBatch(record,data)||!validMaterials(record,'invoice').length||!validMaterials(record,'payment').length||record.paymentVerified!==true||!getExchangeRateEvidence(record,data).valid)return null;
  const amount=cents(record.currency==='CNY'?record.amount:record.exchangeRate?.cnyAmount||'');
  return amount!==null&&amount>0n&&amount<=400000n?amount:null;
}
export function canSelectForBatch(record:RecordItem,data:Workspace):boolean{
  const amount=selectableAmount(record,data);
  if(amount===null)return false;
  const grouped=new Set(activeBatches(data).flatMap(batch=>batch.recordIDs));
  if(grouped.has(record.id))return false;
  return data.records.some(other=>other.id!==record.id&&!grouped.has(other.id)&&((partner)=>partner!==null&&amount+partner<=400000n)(selectableAmount(other,data)));
}
export type BatchStage=1|2|3|4|5|6;
export function batchStage(batch:ClaimBatch,data:Workspace){
  const members=batch.recordIDs.map(id=>data.records.find(record=>record.id===id)).filter((record):record is RecordItem=>!!record);
  const complete=members.length===batch.recordIDs.length&&members.every(isFinanceCompleted);
  if(complete)return {stage:6 as BatchStage,label:'财务审批完全通过',detail:'财务已通过，自动完成。',document:undefined};
  const financePending=members.some(record=>record.financeReviewPending);
  const submitted=members.length===batch.recordIDs.length&&members.every(record=>record.financeReviewPending||record.status==='submitted'||getRecordWorkflow(record,data).find(step=>step.id==='submission')?.state==='done');
  const partial=members.some(record=>record.status==='partial'||record.status==='submitted'||!!record.submittedOn||data.deliveryItems?.some(item=>item.recordID===record.id&&item.status==='submitted'));
  if(financePending||submitted||partial)return {stage:5 as BatchStage,label:financePending?'财务审核中':submitted?'材料已提交':'部分材料已提交',detail:financePending?'财务审核中，前序自动完成。':submitted?'等待财务审核结果。':'请核对其余材料的交付记录。',document:undefined};
  const documents=(data.documents||[]).filter(document=>document.batchID===batch.id&&document.submissionFormat==='separate-invoices-v1'&&(!document.batchVersion||document.batchVersion===batch.version));
  const document=documents.find(candidate=>candidate.ready!==false&&candidate.recordIDs.length===batch.recordIDs.length&&members.length===batch.recordIDs.length&&members.every(record=>candidate.recordIDs.includes(record.id)&&applicationDocuments(record,data).some(ready=>ready.id===candidate.id)));
  if(document)return {stage:4 as BatchStage,label:'材料已确认，可下载 ZIP',detail:'ZIP 包含报销说明 PDF 和各笔发票原件；付款、申请理由及截图在 PDF 中。',document};
  return {stage:3 as BatchStage,label:'准备合并材料',detail:'请完成共同申请理由、逐笔金额及说明 PDF 的检查确认。',document:undefined};
}
/** Preparation visibility never changes batch membership or the shared document's history. */
export function preparingBatches(data:Workspace):ClaimBatch[]{
  return activeBatches(data).filter(batch=>{
    const members=data.records.filter(r=>batch.recordIDs.includes(r.id));
    // Shared content cannot be edited once even one member has entered delivery/finance.
    if(members.some(r=>lockedForBatch(r,data)))return false;
    if(members.length!==batch.recordIDs.length||members.length<2)return true;
    const documents=members.map(record=>applicationDocuments(record,data).filter(doc=>doc.batchID===batch.id&&doc.ready!==false&&(!doc.batchVersion||doc.batchVersion===batch.version)));
    // Every member must reference the same current, fully checked application.
    return !documents[0].some(doc=>documents.every(list=>list.some(item=>item.id===doc.id)));
  });
}
export function batchTitle(records:RecordItem[]) {
  const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
  const currency=sorted[0]?.currency||'';
  const months=[...new Set(sorted.map(r=>r.billingMonth))].join(' / ');
  const original=sorted.reduce((sum,r)=>sum+(cents(r.amount)||0n),0n);
  return `${months} · ${currency} ${decimal(original)}`;
}
