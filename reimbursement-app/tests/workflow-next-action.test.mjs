import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileNextAction, matchesProgress} from '../src/workflow-next-action.ts';
const context={documents:[],materials:[],deliveryItems:[]};
const original=role=>({id:role,role,integrity:'ok',filename:role+'.pdf'});
const record={id:'test',materials:[],currency:'USD',paymentVerified:false,claimConfirmed:false,approvedCNY:'0',claimedCNY:'',status:'needs_review'};
test('mobile action opens the earliest missing evidence, then payment verification',()=>{
  assert.equal(mobileNextAction(record,context).step,'materials');
  assert.equal(mobileNextAction({...record,materials:[original('invoice')]},context).title,'补付款凭证');
  const collected={...record,materials:[original('invoice'),original('payment')]};
  assert.equal(mobileNextAction(collected,context).title,'核验付款');
  assert.equal(mobileNextAction({...collected,paymentVerified:true},context).step,'claim');
});
test('evidence filters expose every gap but never ask finance-stage records for old files',()=>{
  assert.equal(matchesProgress(record,context,'missing-invoice'),true);
  assert.equal(matchesProgress(record,context,'missing-payment'),true);
  const uploaded={...record,materials:[original('payment')]};
  assert.equal(matchesProgress(uploaded,context,'missing-payment'),false);
  assert.equal(matchesProgress(uploaded,context,'verify-payment'),true);
  assert.equal(matchesProgress({...uploaded,paymentVerified:true},context,'verify-payment'),false);
  for(const finance of [{...record,financeReviewPending:true},{...record,claimConfirmed:true,claimedCNY:'100',approvedCNY:'100'}]){
    for(const filter of ['missing-invoice','missing-payment','verify-payment','claim','submission']) assert.equal(matchesProgress(finance,context,filter),false);
  }
  assert.equal(matchesProgress({...record,financeReviewPending:true},context,'finance-pending'),true);
  assert.equal(matchesProgress({...record,claimConfirmed:true,claimedCNY:'100',approvedCNY:'100'},context,'completed'),true);
  assert.equal(matchesProgress({...record,materials:[{...original('payment'),integrity:'missing'}]},context,'missing-payment'),true);
});
test('finance status overrides absent originals without creating new collection work',()=>{
  assert.deepEqual(mobileNextAction({...record,financeReviewPending:true},context),{step:'approval',title:'财务审核中',waiting:true,completed:false});
  assert.deepEqual(mobileNextAction({...record,claimConfirmed:true,claimedCNY:'100',approvedCNY:'100'},context),{step:'approval',title:'已报销',waiting:false,completed:true});
});
