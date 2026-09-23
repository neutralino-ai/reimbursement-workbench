import type {ClaimBatch,RecordItem,Workspace} from './types';
import {applicationDocuments,arePriorStepsComplete} from './workflow.ts';

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
/** Preserve list order and filtering while showing each finished batch only once. */
type BatchListEntry={record:RecordItem;batch?:never}|{batch:ClaimBatch;record?:never};
export function batchListEntries(records:RecordItem[],finished:ClaimBatch[]):BatchListEntry[]{
  const emitted=new Set<string>();
  return records.flatMap<BatchListEntry>(record=>{
    const batch=finished.find(b=>b.recordIDs.includes(record.id));
    if(!batch)return [{record}];
    if(emitted.has(batch.id))return [];
    emitted.add(batch.id);return [{batch}];
  });
}
export function batchTitle(records:RecordItem[]) {
  const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
  const currency=sorted[0]?.currency||'';
  const months=[...new Set(sorted.map(r=>r.billingMonth))].join(' / ');
  const original=sorted.reduce((sum,r)=>sum+(cents(r.amount)||0n),0n);
  return `${months} · ${currency} ${decimal(original)}`;
}
