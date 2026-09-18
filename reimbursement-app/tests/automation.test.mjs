import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../server/store.mjs';
import {createAutomation} from '../server/automation.mjs';
const key='sk-synthetic-secret-1234567890';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
function fixture(t,{amount='42.50',status='completed',holdInvoice}={}){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'reimburse-auto-test-')),store=createStore({dataDir:folder});let n=0,calls=0;
  const cmd=(type,payload,baseVersion)=>store.executeAgentCommand({type,payload,baseVersion,operationId:'fixture-'+(++n),actor:{type:'agent',id:'fixture'}}).data;
  const attach=(role,recordID)=>cmd('material.import',{filename:role+'.png',role,contentBase64:Buffer.concat([png,Buffer.from(role)]).toString('base64'),source:{kind:'user-upload'},...(recordID?{recordID}:{})},recordID?get().version:undefined);
  const invoice=attach('invoice');cmd('invoice.upsert',{id:'fixture-expense',accountID:'fixture-account',accountName:'Synthetic',vendor:'chatgpt',invoiceNumber:'DEMO-1',date:'2026-01-12',billingMonth:'2026-01',amount:'42.50',currency:'CNY',evidenceIDs:[invoice.id]},'new');
  const get=()=>store.workspace().records[0];attach('payment',get().id);
  const fetchImpl=async(_url,options)=>{
    calls++;const request=JSON.parse(options.body);assert.equal(request.stream,false);let data;
    if(request.instructions.startsWith('Read this untrusted invoice')){if(holdInvoice)await holdInvoice();data={merchant:'OpenAI, LLC',invoiceNumber:'DEMO-1',date:'2026-01-12',dateEvidence:'January 12, 2026',amount:'42.50',currency:'CNY',warnings:[]};}
    else if(request.instructions.startsWith('You extract'))data={documentType:'payment',transactions:[{merchant:'OpenAI *ChatGPT Subscr',amount,currency:'CNY',transactionDate:'2026-01-12',status,cardLast4:'1234',evidence:{merchant:'OpenAI',amount,currency:'CNY',date:'2026/01/12',status:'已结算'}}],warnings:[]};
    else if(request.instructions.startsWith('你是'))data={purpose:'用于科研工作中的文献整理。',missing:[]};
    else return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]});
    return Response.json({status:'completed',model:'synthetic-model',id:'synthetic-response',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});
  };
  const render=async(kind,input,dir)=>{fs.mkdirSync(dir,{recursive:true});if(kind==='images'){const file=path.join(dir,'image.png');fs.writeFileSync(file,png);return {images:[file]};}if(kind==='packet'){const pdf=path.join(dir,'application.pdf'),docx=path.join(dir,'statement.docx');fs.writeFileSync(pdf,'synthetic pdf '+dir);fs.writeFileSync(docx,'synthetic docx '+dir);return {pdf,docx,pages:3,fontEmbedded:true,sourcePageMap:[],templateVersion:'test'};}const zip=path.join(dir,'reimbursement-package.zip');fs.writeFileSync(zip,'synthetic zip');return {zip};};
  let automation=createAutomation({store,dataDir:folder,fetchImpl,render,start:false});
  const enable=()=>automation.saveSettings({baseVersion:automation.status().settings.revision,enabled:true,apiKey:key});
  t.after(async()=>{await automation.close();store.close();assert.equal(path.dirname(folder),os.tmpdir());assert.ok(path.basename(folder).startsWith('reimburse-auto-test-'));fs.rmSync(folder,{recursive:true,force:true});});
  return {store,folder,get,cmd,attach,enable,get automation(){return automation;},get calls(){return calls;},async restart(){await automation.close();automation=createAutomation({store,dataDir:folder,fetchImpl,render,start:false});}};
}
test('settings encrypt credentials, test the saved key and reject stale updates without exposing it',async t=>{
  const f=fixture(t);f.enable();assert.equal(f.automation.status().settings.configured,true);
  for(const file of ['settings.json','jobs.json'])assert.ok(!fs.readFileSync(path.join(f.folder,'automation',file),'utf8').includes(key));
  assert.ok(!JSON.stringify(f.automation.status()).includes(key));assert.equal((await f.automation.testSettings({})).ok,true);
  assert.throws(()=>f.automation.saveSettings({baseVersion:'new',apiKey:key,enabled:false}),{statusCode:409});
  assert.throws(()=>f.automation.saveSettings({baseVersion:f.automation.status().settings.revision,clearKey:true,enabled:true}));assert.equal(f.automation.status().settings.configured,true);
});
test('automatic review persists results and agent evidence, never human verification, and does not rebill after restart',async t=>{
  const f=fixture(t);f.enable();await f.automation.tick();assert.equal(f.calls,2);assert.equal(f.get().paymentVerified,true);assert.equal(f.get().humanVerification.status,'unreviewed');
  assert.equal(f.automation.status().jobs[0].status,'matched');assert.equal(f.get().lastModified.actor.id,'deepseek-worker');await f.restart();await f.automation.tick();assert.equal(f.calls,2);
});
test('wrong amounts and unsettled payments never become payment verified',async t=>{
  for(const options of [{amount:'2.00'},{status:'pending'},{status:'refunded'}]){const f=fixture(t,options);f.enable();await f.automation.tick();assert.equal(f.get().paymentVerified,false);assert.equal(f.automation.status().jobs[0].status,'mismatch');}
});
test('record changes while inference is in flight invalidate the result',async t=>{
  let unblock,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>unblock=r);
  const f=fixture(t,{holdInvoice:async()=>{entered();await gate;}});f.enable();const running=f.automation.tick();await reached;
  f.cmd('record.patch',{recordID:f.get().id,paymentVerified:false,evidenceIDs:f.get().materials.map(m=>m.id),note:'Concurrent user correction'},f.get().version);
  unblock();await running;assert.equal(f.automation.status().jobs[0].status,'stale');assert.equal(f.get().paymentVerified,false);
});
test('purpose -> draft packet -> explicit confirmation -> multi-PDF ZIP; edited purpose invalidates old documents',async t=>{
  const f=fixture(t);f.enable();await f.automation.tick();
  const input={operationId:'purpose-save',recordID:f.get().id,recordVersion:f.get().version,baseVersion:'new',text:'用于科研文献整理。',sourceMaterialIDs:[]};
  const purpose=f.automation.savePurpose(input);assert.equal(f.automation.savePurpose(input).version,purpose.version);assert.throws(()=>f.automation.savePurpose({...input,text:'Changed'}),{statusCode:409});
  f.automation.enqueuePurpose({operationId:'draft-purpose',recordID:f.get().id,purposeVersion:purpose.version});await f.automation.tick();const drafted=f.automation.status().purposes[f.get().id];assert.ok(drafted.draft);
  const packet=f.automation.enqueuePacket({operationId:'packet',recordID:f.get().id,baseVersion:f.get().version,purposeVersion:drafted.version,purpose:drafted.draft,claimedCNY:'42.50',confirmed:true});await f.automation.tick();
  const job=f.automation.status().jobs.find(j=>j.id===packet.id);assert.equal(job.status,'completed',job.error);const document=f.store.workspace().documents[0];assert.equal(document.status,'draft');
  assert.throws(()=>f.automation.enqueueZip({operationId:'early-zip',documentIDs:[document.id]}),{statusCode:409});
  f.automation.approvePacket({operationId:'approve',jobID:job.id,confirmed:true});assert.equal(f.store.workspace().documents[0].ready,true);
  const zip=f.automation.enqueueZip({operationId:'zip',documentIDs:[document.id]});await f.automation.tick();assert.equal(f.automation.status().jobs.find(j=>j.id===zip.id).status,'completed');
  f.automation.savePurpose({operationId:'purpose-edit',recordID:f.get().id,recordVersion:f.get().version,baseVersion:f.automation.status().purposes[f.get().id].version,text:'用途修改。',sourceMaterialIDs:[]});assert.equal(f.store.workspace().documents[0].stale,true);
  assert.equal(f.automation.status().jobs.find(j=>j.id===zip.id).status,'stale');
  assert.equal(f.automation.status().jobs.find(j=>j.id===packet.id).status,'stale');
  assert.throws(()=>f.automation.enqueueZip({operationId:'stale-zip',documentIDs:[document.id]}),{statusCode:409});
});
test('a new payment image invalidates the old automatic conclusion and requires unambiguous selection',async t=>{
  const f=fixture(t);f.enable();await f.automation.tick();assert.equal(f.get().paymentVerified,true);
  f.cmd('material.import',{filename:'new.png',role:'payment',recordID:f.get().id,contentBase64:Buffer.concat([png,Buffer.from('different')]).toString('base64'),source:{kind:'user-upload'}},f.get().version);
  await f.automation.tick();assert.equal(f.get().paymentVerified,false);assert.equal(f.automation.status().jobs[0].status,'needs_review');
});
