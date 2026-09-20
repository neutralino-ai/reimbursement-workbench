import test from 'node:test';
import assert from 'node:assert/strict';
import {canAdoptBatchPurpose,batchPurposeLabel} from '../src/batch-purpose.ts';
const job={kind:'batch-purpose',status:'completed',current:true,sourceBatchVersion:'v1',result:{purpose:'科研用途草稿'}};
test('only a current completed suggestion matching the saved version can be explicitly adopted',()=>{
  assert.equal(canAdoptBatchPurpose(job,'v1',false),true);
  for(const changed of [{status:'queued'},{status:'running'},{status:'failed'},{status:'interrupted'},{status:'stale'},{current:false},{current:undefined},{kind:'batch-packet'},{result:{purpose:'  '}}])assert.equal(canAdoptBatchPurpose({...job,...changed},'v1',false),false);
  assert.equal(canAdoptBatchPurpose(job,'v2',false),false);assert.equal(canAdoptBatchPurpose(job,undefined,false),false);
  assert.equal(canAdoptBatchPurpose(job,'v1',true),false,'unsaved edits, upload, lock or active job protect existing text');
});
test('stale and failed results are not presented as successful current drafts',()=>{
  assert.match(batchPurposeLabel({...job,current:false}),/已变化/);assert.match(batchPurposeLabel({...job,status:'failed'}),/失败/);assert.match(batchPurposeLabel({...job,status:'interrupted'}),/手动重试/);assert.match(batchPurposeLabel(job),/已生成/);
});
