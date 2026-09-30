import test from 'node:test';
import assert from 'node:assert/strict';
import {currentSupplementReview,supplementReadyReason} from '../src/invoice-supplement.ts';

const review={id:'review',kind:'supplement-review',materialID:'signed',batchID:'batch-a',status:'matched',current:true,createdAt:'2026-09-30T00:00:00Z'};
test('only a current DeepSeek pass clears the supplement requirement',()=>{
  assert.equal(supplementReadyReason(review,'signed'),'');
  for(const status of ['queued','running','needs_review','failed','interrupted','stale'])assert.ok(supplementReadyReason({...review,status},'signed'));
  assert.ok(supplementReadyReason({...review,current:false},'signed'));
  assert.ok(supplementReadyReason({...review,current:undefined},'signed'));
  assert.ok(supplementReadyReason(undefined,'signed'));
  assert.ok(supplementReadyReason(review,''));
});
test('a review is bound to the selected file and exact application package',()=>{
  assert.equal(currentSupplementReview([review],'signed','batch-a'),review);
  assert.equal(currentSupplementReview([review],'signed','batch-b'),undefined);
  assert.equal(currentSupplementReview([review],'replacement','batch-a'),undefined);
  assert.equal(currentSupplementReview([review],'signed',undefined,'single'),undefined);
  const single={...review,batchID:undefined,recordID:'single'};
  assert.equal(currentSupplementReview([single],'signed',undefined,'single'),single);
});
test('latest failed or pending retry cannot be hidden by an older successful review',()=>{
  const pending={...review,id:'retry',status:'queued'};
  const selected=currentSupplementReview([pending,review],'signed','batch-a');
  assert.equal(selected,pending);assert.ok(supplementReadyReason(selected,'signed'));
});
test('concrete model and provider failures stay visible to the user',()=>{
  assert.equal(supplementReadyReason({...review,status:'needs_review',result:{reasons:['缺少领导签字','未覆盖第二张发票']}},'signed'),'缺少领导签字 未覆盖第二张发票');
  assert.equal(supplementReadyReason({...review,status:'failed',error:'DeepSeek HTTP 429'},'signed'),'DeepSeek HTTP 429');
});
