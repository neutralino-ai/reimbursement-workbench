import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createApp} from '../server/index.mjs';
import {issueSetup} from '../server/cloud-auth.mjs';

test('cloud mounts isolate all evidence behind human sessions or agent authorization',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'reimbursement-cloud-http-'));
  const origin='https://reimburse.example.test';
  const app=await createApp({dataDir:folder,publicUrl:origin+'/reimbursement'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const request=(route,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request(base+route,{method,headers:{host:'reimburse.example.test',...headers,...(body?{'content-type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const bytes=Buffer.concat(chunks);let json;try{json=JSON.parse(bytes);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,json});});});
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try {
    for(const route of ['/api/workspace','/api/export','/api/materials/guessed','/api/tasks']) assert.equal((await request('/reimbursement'+route)).status,401);
    assert.equal((await request('/api/workspace')).status,404);
    assert.equal((await request('/reimbursement/api/workspace',{headers:{host:'evil.test'}})).status,403);
    assert.equal((await request('/reimbursement/api/auth/status')).json.configured,false);
    const setup=await issueSetup({dataDir:folder,publicOrigin:origin,basePath:'/reimbursement'});
    const password='Fixture long password only!';
    assert.equal((await request('/reimbursement/api/auth/setup',{method:'POST',body:{token:setup.token,password}})).status,403);
    assert.equal((await request('/reimbursement/api/auth/setup',{method:'POST',headers:{origin:'https://evil.test'},body:{token:setup.token,password}})).status,403);
    assert.equal((await request('/reimbursement/api/auth/setup',{method:'POST',headers:{origin},body:{token:setup.token,password}})).status,200);
    const login=await request('/reimbursement/api/auth/login',{method:'POST',headers:{origin},body:{password}});
    assert.equal(login.status,200); assert.match(login.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const workspace=await request('/reimbursement/api/workspace',{headers:{cookie}});
    assert.equal(workspace.status,200);
    assert.equal((await request('/reimbursement/api/workspace',{headers:{cookie,origin:'https://evil.test'}})).status,403);
    const token=JSON.parse(fs.readFileSync(app.agentConfigPath,'utf8')).token;
    const agent={authorization:'Bearer '+token};
    assert.equal((await request('/reimbursement/api/workspace',{headers:agent})).status,403);
    assert.equal((await request('/reimbursement/api/agent/commands',{method:'POST',headers:agent,body:{type:'workspace.get',actor:{type:'agent',id:'test'},payload:{}}})).status,200);
    const imported=await request('/reimbursement/api/agent/commands',{method:'POST',headers:agent,body:{type:'material.import',operationId:'cloud-import',actor:{type:'agent',id:'test'},payload:{role:'observation',filename:'fixture.json',contentBase64:Buffer.from('{"test":true}').toString('base64'),source:{kind:'generated'}}}});
    assert.equal(imported.status,200);
    assert.match(imported.json.data.href,/^\/reimbursement\/api\/materials\//);
    assert.equal((await request(imported.json.data.href)).status,401);
    assert.equal((await request(imported.json.data.href,{headers:agent})).bytes.toString(),'{"test":true}');
    assert.equal((await request('/reimbursement/api/policies/upload',{method:'POST',headers:{...agent,origin,cookie},body:{}})).status,403);
    assert.equal((await request('/reimbursement/api/auth/logout',{method:'POST',headers:{origin,cookie},body:{}})).status,200);
    assert.equal((await request('/reimbursement/api/workspace',{headers:{cookie}})).status,401);
  } finally {
    await app.close();
    assert.equal(path.dirname(folder),os.tmpdir());assert.ok(path.basename(folder).startsWith('reimbursement-cloud-http-'));
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
