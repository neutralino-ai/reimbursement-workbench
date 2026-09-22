import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileNextAction} from '../src/workflow-next-action.ts';
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
test('finance status overrides absent originals without creating new collection work',()=>{
  assert.deepEqual(mobileNextAction({...record,financeReviewPending:true},context),{step:'approval',title:'财务审核中',waiting:true,completed:false});
  assert.deepEqual(mobileNextAction({...record,claimConfirmed:true,claimedCNY:'100',approvedCNY:'100'},context),{step:'approval',title:'已报销',waiting:false,completed:true});
});
