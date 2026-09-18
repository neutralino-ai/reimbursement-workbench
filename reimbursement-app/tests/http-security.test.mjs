import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {createApp} from '../server/index.mjs';

test('local API rejects foreign origins and DNS rebinding hosts',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'reimbursement-http-'));
  const legacyDir=path.join(folder,'legacy');
  const appData=path.join(legacyDir,'private-data','AppData');
  mkdirSync(path.join(appData,'materials'),{recursive:true});
  writeFileSync(path.join(appData,'workspace.json'),JSON.stringify({schemaVersion:3,accounts:[],records:[],inbox:[],reviews:[],reconciliation:{arpPayments:[],vendorPayments:[],allocations:[],confirmedClaimRecordIDs:[]}}));
  const application=await createApp({dataDir:path.join(folder,'data'),legacyDir});
  await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${application.server.address().port}`;
  try {
    const local=await fetch(base+'/api/workspace');
    assert.equal(local.status,200);
    assert.equal((await local.json()).records.length,0);
    assert.equal(local.headers.get('cache-control'),'no-store');
    const remote=await fetch(base+'/api/workspace',{headers:{Origin:'https://untrusted.example'}});
    assert.equal(remote.status,403);
    // Undici normalizes Host; use an actual HTTP request to test the wire header.
    const reboundStatus=await new Promise((resolve,reject)=>{
      const req=request(base+'/api/workspace',{headers:{Host:'untrusted.example'}},res=>{
        res.resume();
        res.on('end',()=>resolve(res.statusCode));
      });
      req.on('error',reject);
      req.end();
    });
    assert.equal(reboundStatus,403);
    const missingOrigin=await fetch(base+'/api/allocations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(missingOrigin.status,403);
    const crossSite=await fetch(base+'/api/workspace',{headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSite.status,403);
    const malformed=await fetch(base+'/api/allocations',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{'});
    assert.equal(malformed.status,400);
    assert.match((await malformed.json()).error,/JSON/);
    const arbitraryFile=await fetch(base+'/api/materials/not-a-known-material');
    assert.equal(arbitraryFile.status,404);
    const exported=await fetch(base+'/api/export');
    assert.equal(exported.status,200);
    assert.match(exported.headers.get('content-disposition'),/attachment/);
  } finally {
    await application.close();
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith('reimbursement-http-'));
    rmSync(folder,{recursive:true,force:true});
  }
});
