export type BatchLocalDraft = {
  schema:1; id:string; recordIDs:string[]; baseVersion:string; savedAt:string;
  purpose:string; sourceIDs:string[]; draft:{jobID:string;text:string}|null;
};
type StorageLike = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function batchDraftKey(server:string,recordIDs:string[]) {
  return 'reimbursement.batch-draft.v1:'+JSON.stringify([server,[...recordIDs].sort()]);
}
export function readBatchDraft(storage:StorageLike,key:string):BatchLocalDraft|null {
  const raw=storage.getItem(key);
  if(!raw)return null;
  const value=JSON.parse(raw);
  if(value?.schema!==1||typeof value.id!=='string'||typeof value.baseVersion!=='string'||
    !Number.isFinite(Date.parse(value.savedAt))||typeof value.purpose!=='string'||
    !Array.isArray(value.recordIDs)||!value.recordIDs.every((id:unknown)=>typeof id==='string')||
    !Array.isArray(value.sourceIDs)||!value.sourceIDs.every((id:unknown)=>typeof id==='string')||
    (value.draft!==null&&(typeof value.draft?.jobID!=='string'||typeof value.draft?.text!=='string')))
    throw new Error('本机暂存内容无法读取，请保留当前编辑内容并重新暂存。');
  return value;
}
export function writeBatchDraft(storage:StorageLike,key:string,value:BatchLocalDraft) {
  storage.setItem(key,JSON.stringify(value));
}
export function listBatchDrafts(storage:Storage,server:string):BatchLocalDraft[] {
  const drafts:BatchLocalDraft[]=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i);
    if(!key?.startsWith('reimbursement.batch-draft.v1:'))continue;
    try{const draft=readBatchDraft(storage,key);if(draft&&key===batchDraftKey(server,draft.recordIDs))drafts.push(draft);}catch{/* Other valid drafts remain recoverable. */}
  }
  return drafts.sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
}
