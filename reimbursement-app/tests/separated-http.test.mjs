import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server/index.mjs';
import {issueSetup} from '../server/cloud-auth.mjs';

for(const origin of ['http://127.0.0.1:4317','reimbursement://app'])test(`separate frontend ${origin} uses allowlisted CORS and human sessions for data, downloads and mutations`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reimbursement-separated-'));
 const publicOrigin='https://api.example.test';
 const app=await createApp({dataDir:dir,publicUrl:publicOrigin+'/reimbursement',frontendOrigins:[origin]});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const request=(route,headers={},body,method=body?'POST':'GET')=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:'/reimbursement'+route,method,headers:{host:'api.example.test',...headers,...(body?{'content-type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks);let json;try{json=JSON.parse(bytes);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,json});});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 try {
  assert.equal(app.store.workspace().records.length,0,'An explicit isolated data directory must not import adjacent private legacy files');
  assert.equal((await request('/')).status,404,'API deployment never serves frontend');
  const preflight=await request('/api/auth/login',{origin,'sec-fetch-site':'cross-site','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'},undefined,'OPTIONS');
  assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-allow-origin'],origin);
  assert.equal(preflight.headers['access-control-allow-credentials'],undefined,'No third-party cookies');
  for(const evil of ['null','https://evil.test','http://127.0.0.1:9999','reimbursement://evil','reimbursement://app.evil','reimbursement://app:444',...(origin==='reimbursement://app'?[]:['reimbursement://app'])]){
   const result=await request('/api/workspace',{origin:evil});assert.equal(result.status,403);assert.equal(result.headers['access-control-allow-origin'],undefined);
   const deniedPreflight=await request('/api/auth/login',{origin:evil,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'},undefined,'OPTIONS');assert.equal(deniedPreflight.status,403);assert.equal(deniedPreflight.headers['access-control-allow-origin'],undefined);
  }
  assert.equal((await request('/api/auth/status',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await request('/api/auth/login',{origin,'access-control-request-method':'PATCH'},undefined,'OPTIONS')).status,403);
  const unauthorized=await request('/api/workspace',{origin});assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers['access-control-allow-origin'],origin);
  const setupFrontend='http://127.0.0.1:4317';
  const setup=await issueSetup({dataDir:dir,publicOrigin,basePath:'/reimbursement',frontendUrl:setupFrontend+'/'});
  assert.ok(setup.url.startsWith(setupFrontend+'/#setup='));
  const password='Synthetic separation password only';
  assert.equal((await request('/api/auth/setup',{origin},{token:setup.token,password})).status,200);
  const login=await request('/api/auth/login',{origin,'sec-fetch-site':'cross-site'},{password,sessionMode:'header'});
  assert.equal(login.status,200);assert.equal(login.headers['set-cookie'],undefined);assert.match(login.json.sessionToken,/^[a-f0-9]{64}$/);
  const human={origin,authorization:'Session '+login.json.sessionToken,'sec-fetch-site':'cross-site'};
  assert.equal((await request('/api/auth/status',human)).json.authenticated,true);
  const workspace=await request('/api/workspace',human);assert.equal(workspace.status,200);assert.equal(workspace.headers['access-control-allow-origin'],origin);
  const token=JSON.parse(fs.readFileSync(app.agentConfigPath,'utf8')).token;
  const agent={authorization:'Bearer '+token};
  assert.equal((await request('/api/agent/workspace',{authorization:token})).status,401,'An agent token requires the explicit Bearer scheme');
  const command=(type,payload,baseVersion)=>({type,payload,baseVersion,actor:{type:'agent',id:'fixture'},operationId:'separated-'+type});
  const imported=await request('/api/agent/commands',agent,command('material.import',{filename:'synthetic-invoice.pdf',role:'invoice',contentBase64:Buffer.from('%PDF-1.4 synthetic fixture').toString('base64'),source:{kind:'generated'}}));
  assert.equal(imported.status,200);
  const material=imported.json.data;
  const invoice=await request('/api/agent/commands',agent,command('invoice.upsert',{id:'separated-invoice',accountID:'fixture',accountName:'Synthetic',vendor:'chatgpt',invoiceNumber:'SYNTHETIC-ONLY',date:'2026-01-25',billingMonth:'2026-01',amount:'1.00',currency:'USD',evidenceIDs:[material.id]},'new'));
  assert.equal(invoice.status,200);
  const materialRoute=material.href.slice('/reimbursement'.length);
  const file=await request(materialRoute,human);assert.equal(file.status,200);assert.equal(file.bytes.toString(),'%PDF-1.4 synthetic fixture');
  assert.equal(file.headers['access-control-allow-origin'],origin);assert.match(file.headers['access-control-expose-headers'],/Content-Disposition/);
  assert.equal((await request(materialRoute)).status,401);
  assert.equal((await request('/api/export',human)).status,200);
  const delivery=await request('/api/records/separated-invoice/delivery',human,{materialID:material.id,status:'not_submitted',baseVersion:'new'});
  assert.equal(delivery.status,200);assert.equal(delivery.json.actor.type,'human');
  assert.equal((await request('/api/records/separated-invoice/delivery',{...agent,origin},{materialID:material.id,status:'not_submitted',baseVersion:delivery.json.version})).status,403);
  assert.equal((await request('/api/agent/workspace',human)).status,401,'Human credentials do not become agent identity');
  assert.equal((await request('/api/workspace',{origin,authorization:'Session '+token})).status,401,'Agent token cannot be relabelled as human');
  assert.equal((await request('/api/workspace',{...human,origin:'https://evil.test'})).status,403);
  assert.equal((await request('/api/auth/logout',human,{})).status,200);
  assert.equal((await request('/api/workspace',human)).status,401);
 }finally{await app.close();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('reimbursement-separated-'));fs.rmSync(dir,{recursive:true,force:true});}
});

test('frontend origin configuration rejects wildcard, opaque, public HTTP and noncanonical desktop origins',async()=>{
 for(const origin of ['*','null','http://remote.example','https://good.example/path','https://good.example/','file://','reimbursement://evil','reimbursement://app/','reimbursement://app:444','reimbursement://user@app','reimbursement://app?query','other://app'])await assert.rejects(createApp({publicUrl:'https://api.example/reimbursement',frontendOrigins:[origin]}));
});
