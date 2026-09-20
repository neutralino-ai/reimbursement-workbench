import test from 'node:test';
import assert from 'node:assert/strict';
import {batchAmounts,activeBatches,lockedForBatch,batchTitle} from '../src/claim-batches.ts';
const expense=(id,changes={})=>({id,amount:'200.00',currency:'USD',date:'2026-05-25',billingMonth:'2026-05',exchangeRate:{valid:true,cnyAmount:'1400.01'},...changes});
test('sum per-invoice rounded CNY, never reuse one FX rate for the whole USD total',()=>{
  const result=batchAmounts([expense('a'),expense('b',{exchangeRate:{valid:true,cnyAmount:'1420.02'}})]);assert.equal(result.totalCNY,'2820.03');assert.equal(result.overLimit,false);
  assert.match(batchTitle([expense('a'),expense('b')]),/USD 400.00/);
});
test('missing/invalid FX blocks totals; exact limit and one cent over are distinguished',()=>{
  assert.equal(batchAmounts([expense('a',{exchangeRate:{valid:false,cnyAmount:'100'}}),expense('b')]).total,null);
  assert.equal(batchAmounts([expense('a',{currency:'CNY',amount:'2000.00'}),expense('b',{currency:'CNY',amount:'2000.00'})]).overLimit,false);
  assert.equal(batchAmounts([expense('a',{currency:'CNY',amount:'2000.01'}),expense('b',{currency:'CNY',amount:'2000.00'})]).overLimit,true);
});
test('active membership and financial state remain distinct from temporary selection',()=>{
  assert.equal(activeBatches({claimBatches:[{id:'active',status:'active'},{id:'old',status:'archived'}]}).length,1);
  assert.equal(lockedForBatch(expense('a'),{}),false);
  assert.equal(lockedForBatch(expense('a'),{deliveryItems:[{recordID:'a',status:'submitted'}]}),true);
  for(const changes of [{status:'completed'},{financeReviewPending:true},{submissionReference:'ARP'},{approvedCNY:'1.00'}])assert.equal(lockedForBatch(expense('a',changes),{}),true);
});
