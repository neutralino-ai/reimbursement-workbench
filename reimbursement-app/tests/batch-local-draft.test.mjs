import test from 'node:test';
import assert from 'node:assert/strict';
import {batchDraftKey,readBatchDraft,writeBatchDraft,listBatchDrafts} from '../src/batch-local-draft.ts';
const draft={schema:1,id:'batch-1',recordIDs:['r1','r2'],baseVersion:'v1',savedAt:'2026-09-22T01:00:00Z',purpose:'共同用途',sourceIDs:['s1'],draft:{jobID:'j1',text:'用户修改后的草稿'}};
const storage=()=>{const data=new Map();return {get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};};
test('local drafts survive reopening with reversed selection and retain edited text and source IDs',()=>{
  const local=storage(),key=batchDraftKey('https://server/reimbursement',draft.recordIDs);
  assert.equal(readBatchDraft(local,key),null);
  writeBatchDraft(local,key,draft);
  assert.deepEqual(readBatchDraft(local,batchDraftKey('https://server/reimbursement',['r2','r1'])),draft);
  assert.equal(readBatchDraft(local,batchDraftKey('https://other/reimbursement',draft.recordIDs)),null);
  assert.equal(readBatchDraft(local,batchDraftKey('https://server/reimbursement',['r1','r3'])),null);
});
test('corrupt caches and denied writes are reported rather than claimed as saved',()=>{
  const local=storage();
  for(const value of ['invalid','null',JSON.stringify({...draft,schema:2}),JSON.stringify({...draft,draft:{jobID:'j1'}})]){
    local.setItem('key',value);assert.throws(()=>readBatchDraft(local,'key'));
  }
  assert.throws(()=>writeBatchDraft({setItem(){throw new Error('QuotaExceeded');}},'key',draft),/QuotaExceeded/);
});
test('resume list includes only valid drafts belonging to the current server',()=>{
  const local=storage();
  writeBatchDraft(local,batchDraftKey('server-a',draft.recordIDs),draft);
  writeBatchDraft(local,batchDraftKey('server-b',draft.recordIDs),{...draft,id:'another-server'});
  local.setItem('reimbursement.batch-draft.v1:broken','invalid');
  local.setItem('unrelated','invalid');
  assert.deepEqual(listBatchDrafts(local,'server-a'),[draft]);
});
