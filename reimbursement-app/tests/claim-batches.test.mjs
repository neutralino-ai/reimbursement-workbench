import test from 'node:test';
import assert from 'node:assert/strict';
import {batchAmounts,activeBatches,preparingBatches,lockedForBatch,batchTitle,batchStage,canSelectForBatch} from '../src/claim-batches.ts';
const expense=(id,changes={})=>({id,amount:'200.00',currency:'USD',date:'2026-05-25',billingMonth:'2026-05',exchangeRate:{valid:true,cnyAmount:'1400.01'},...changes});
test('sum per-invoice rounded CNY, never reuse one FX rate for the whole USD total',()=>{
  const result=batchAmounts([expense('a'),expense('b',{exchangeRate:{valid:true,cnyAmount:'1420.02'}})]);assert.equal(result.totalCNY,'2820.03');assert.equal(result.overLimit,false);
  assert.match(batchTitle([expense('a'),expense('b')]),/USD 400.00/);
});

function preparedBatch(){
  const material=(id,role,filename=id+'.pdf')=>({id,role,filename,integrity:'ok'});
  const records=['a','b'].map(id=>expense(id,{currency:'CNY',amount:'100.00',claimedCNY:'100.00',claimConfirmed:true,paymentVerified:true,materials:[material(id+'-invoice','invoice'),material(id+'-payment','payment')]}));
  const batch={id:'batch',version:'v1',recordIDs:['a','b'],status:'active'};
  const document={id:'doc',batchID:batch.id,batchVersion:batch.version,recordIDs:batch.recordIDs,purpose:'application',submissionFormat:'separate-invoices-v1',status:'ready',ready:true,stale:false,needsUpdate:false,sourceMaterialIDs:records.flatMap(r=>r.materials.map(m=>m.id)),materialIDs:['pdf','word'],submissionPDFMaterialID:'pdf',materials:[material('pdf','document'),material('word','document','source.docx')]};
  return {records,claimBatches:[batch],documents:[document],deliveryItems:[]};
}
test('ready combined materials leave preparation without archiving or losing membership',()=>{
  const data=preparedBatch(),before=structuredClone(data);
  assert.deepEqual(preparingBatches(data),[]);
  assert.deepEqual(activeBatches(data),data.claimBatches,'completed members remain reserved against duplicate grouping');
  assert.deepEqual(data,before,'presentation must never write business state');
  data.documents=[];
  assert.deepEqual(preparingBatches(data),data.claimBatches,'unprepared groups remain visible');
});
test('a generated PDF, stale version or incomplete evidence cannot count as preparation complete',()=>{
  for(const change of [{status:'draft',ready:false},{ready:false},{stale:true},{needsUpdate:true},{batchVersion:'old'},{recordIDs:['a']},{purpose:'review'},{materials:[]},{sourceMaterialIDs:['a-invoice','a-payment']}]){
    const data=preparedBatch();Object.assign(data.documents[0],change);
    assert.equal(preparingBatches(data).length,1,JSON.stringify(change));
  }
  const data=preparedBatch();data.records[1].materials[0].integrity='missing';
  assert.equal(preparingBatches(data).length,1,'one missing member invoice keeps the whole group pending');
  data.records.pop();assert.equal(preparingBatches(data).length,1,'missing members cannot be treated as prepared');
});
test('submitted or finance-stage members stay out of preparation even when old documents become stale',()=>{
  for(const change of [{status:'submitted'},{status:'partial'},{submittedOn:'2026-09-23'},{submissionReference:'ARP'},{financeReviewPending:true},{status:'completed'},{approvedCNY:'100.00'}]){
    const data=preparedBatch();data.documents[0].stale=true;Object.assign(data.records[0],change);
    assert.deepEqual(preparingBatches(data),[],JSON.stringify(change));
    assert.equal(activeBatches(data).length,1);
  }
  const data=preparedBatch();data.documents=[];data.deliveryItems=[{recordID:'a',materialID:'pdf',status:'submitted'}];
  assert.deepEqual(preparingBatches(data),[],'partial delivery locks shared preparation rather than exposing an unusable editor');
});
test('different per-record documents do not complete the shared package; archived groups stay hidden',()=>{
  const data=preparedBatch(),doc=data.documents[0];
  data.documents=[{...doc,id:'doc-a',recordIDs:['a']},{...doc,id:'doc-b',recordIDs:['b']}];
  assert.equal(preparingBatches(data).length,1);
  data.claimBatches[0].status='archived';assert.deepEqual(preparingBatches(data),[]);
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
test('merge stages follow evidence and do not treat a PDF draft as a downloadable ZIP package',()=>{
  const data=preparedBatch();
  assert.equal(batchStage(data.claimBatches[0],data).stage,4);
  assert.equal(batchStage(data.claimBatches[0],data).document?.id,'doc');
  data.documents[0].submissionFormat='integrated-v1';
  assert.equal(batchStage(data.claimBatches[0],data).stage,3);
  data.documents[0].submissionFormat='separate-invoices-v1';data.documents[0].stale=true;
  assert.equal(batchStage(data.claimBatches[0],data).stage,3);
  data.documents[0].stale=false;
  data.documents[0].ready=false;
  assert.equal(batchStage(data.claimBatches[0],data).stage,3);
  data.documents[0].ready=true;
  data.deliveryItems=[{recordID:'a',materialID:'pdf',status:'submitted'}];
  assert.match(batchStage(data.claimBatches[0],data).label,/部分/);
  data.records.forEach(record=>{record.financeReviewPending=true;});
  assert.equal(batchStage(data.claimBatches[0],data).stage,5);
  data.records.forEach(record=>{record.status='completed';});
  assert.equal(batchStage(data.claimBatches[0],data).stage,6);
});
test('only records at preparation with verified payment can be selected for a new batch',()=>{
  const data=preparedBatch();data.claimBatches=[];const record=data.records[0];
  assert.equal(canSelectForBatch(record,data),true);
  record.paymentVerified=false;assert.equal(canSelectForBatch(record,data),false);
  record.paymentVerified=true;record.materials[0].integrity='missing';assert.equal(canSelectForBatch(record,data),false);
  record.materials[0].integrity='ok';data.records[1].amount='3999.00';
  assert.equal(canSelectForBatch(record,data),false,'a partner above the combined limit is not eligible');
  data.records[1].amount='100.00';data.records.pop();
  assert.equal(canSelectForBatch(record,data),false,'one ready record alone is not a mergeable group');
});
