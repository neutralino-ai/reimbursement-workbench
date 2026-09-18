import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createApp} from '../server/index.mjs';
import {issueSetup} from '../server/cloud-auth.mjs';
test('AI settings require a human session, never expose the API key and keep agent approval separate',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reimburse-auto-http-'));
  const origin='https://fixture.example.test';const app=await createApp({dataDir:directory,publicUrl:origin+'/reimbursement',apiOnly:true,automation:{start:false,fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const request=(route,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:'/reimbursement'+route,method,headers:{host:'fixture.example.test',...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,text,json:JSON.parse(text)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  try{
    assert.equal((await request('/api/automation')).status,401);
    const token=JSON.parse(fs.readFileSync(app.agentConfigPath,'utf8')).token;
    for(const action of ['settings','test','approve-packet'])assert.equal((await request('/api/agent/automation/'+action,{method:'POST',headers:{authorization:'Bearer '+token},body:{}})).status,403);
    const setup=await issueSetup({dataDir:directory,publicOrigin:origin,basePath:'/reimbursement'});
    await request('/api/auth/setup',{method:'POST',headers:{origin},body:{token:setup.token,password:'Fixture password for local test only'}});
    const login=await request('/api/auth/login',{method:'POST',headers:{origin},body:{password:'Fixture password for local test only',sessionMode:'header'}});
    const headers={origin,authorization:'Session '+login.json.sessionToken};
    const key='sk-synthetic-private-api-123456789';
    const saved=await request('/api/automation/settings',{method:'POST',headers,body:{baseVersion:'new',enabled:true,apiKey:key}});assert.equal(saved.status,200);assert.equal(saved.json.configured,true);
    for(const route of ['/api/automation','/api/workspace','/api/export']){const result=await request(route,{headers});assert.equal(result.status,200);assert.ok(!result.text.includes(key));assert.ok(!result.text.includes('encryptedKey'));}
    assert.equal((await request('/api/automation/test',{method:'POST',headers,body:{}})).json.ok,true);
    assert.equal((await request('/api/automation/settings',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:{baseVersion:saved.json.revision,enabled:false}})).status,403);
  }finally{await app.close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('reimburse-auto-http-'));fs.rmSync(directory,{recursive:true,force:true});}
});
