import test from 'node:test';
import assert from 'node:assert/strict';
import {batchPDFReason,batchAdoptionReason} from '../src/batch-action-reasons.ts';
import {canAdoptBatchPurpose} from '../src/batch-purpose.ts';
const records=['a','b'].map((id,i)=>({id,billingMonth:`2026-0${i+1}`,invoiceNumber:`INV-${id}`,currency:'CNY',amount:'100.00',paymentVerified:true}));
test('PDF blockers identify every missing prerequisite and name unverified invoices',()=>{
  assert.equal(batchPDFReason(records,'用途',[],[]),'');
  assert.match(batchPDFReason([records[0]],'用途',[],[]),/至少选择 2 笔/);
  const reason=batchPDFReason([{...records[0],paymentVerified:false,currency:'USD'},records[1]],' ',['missing'],[]);
  assert.match(reason,/2026-01（INV-a）.*付款尚未核验/);
  assert.match(reason,/有效汇率/);assert.match(reason,/共同科研用途说明/);assert.match(reason,/科研截图已缺失/);
  assert.match(batchPDFReason(records.map(r=>({...r,amount:'2000.01'})),'用途',[],[]),/超过 ¥4,000/);
  assert.equal(batchPDFReason(records,'用途',['e'],[{id:'e',integrity:'ok'}]),'');
});
test('adoption reasons agree with the existing safety checks instead of enabling stale results',()=>{
  const job={kind:'batch-purpose',status:'completed',current:true,sourceBatchVersion:'v1',result:{purpose:'原草稿'}};
  for(const change of [{},{status:'queued'},{status:'running'},{status:'failed'},{status:'interrupted'},{status:'stale'},{current:false},{current:undefined},{sourceBatchVersion:'v0'},{kind:'packet'},{result:{purpose:' '}}]){
    const sample={...job,...change};
    assert.equal(!batchAdoptionReason(sample,'v1','用户改写',false),canAdoptBatchPurpose(sample,'v1',false),JSON.stringify(change));
  }
  assert.match(batchAdoptionReason(job,'v1','',false),/草稿为空/);
  assert.match(batchAdoptionReason(job,'v1','用户改写',true),/未保存的修改/);
  assert.match(batchAdoptionReason(job,undefined,'用户改写',false),/先保存/);
});
