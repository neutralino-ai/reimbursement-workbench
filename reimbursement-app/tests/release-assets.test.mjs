import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(app,'package.json'))).version;
const names=[`Reimbursement-${version}-mac-arm64.dmg`,`Reimbursement-${version}-mac-arm64.zip`,`Reimbursement-${version}-mac-x64.dmg`,`Reimbursement-${version}-mac-x64.zip`,`Reimbursement-${version}-win-x64.exe`];
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reimbursement-release-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=path.join(root,'input'),output=path.join(root,'output');
  fs.mkdirSync(input);
  for(const name of names)fs.writeFileSync(path.join(input,name),Buffer.alloc(1_000_001,42));
  return {input,output};
}
function collect(f,url){return spawnSync(process.execPath,['scripts/collect-release.mjs',f.input,f.output],{cwd:app,env:{...process.env,TESTFLIGHT_PUBLIC_URL:url},encoding:'utf8'});}
test('collector refuses incomplete iOS distribution before publishing any artifact',t=>{
  const f=fixture(t);
  assert.notEqual(collect(f,'').status,0);
  assert.equal(fs.existsSync(f.output),false);
});
test('collector produces a TestFlight entry and checksum alongside every desktop asset',t=>{
  const f=fixture(t),url='https://testflight.apple.com/join/Abcd1234';
  const result=collect(f,url);assert.equal(result.status,0,result.stderr);
  const install=fs.readFileSync(path.join(f.output,'iOS-Installation.md'));
  assert.ok(install.toString().includes(url));
  const sums=fs.readFileSync(path.join(f.output,'SHA256SUMS'),'utf8').trim().split('\n');
  assert.equal(sums.length,6);
  assert.ok(sums.includes(createHash('sha256').update(install).digest('hex')+'  iOS-Installation.md'));
  assert.notEqual(collect(f,url).status,0,'Existing artifacts must not be overwritten');
});
test('collector refuses an incomplete desktop set even with an iOS link',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.input,names[0]));
  assert.notEqual(collect(f,'https://testflight.apple.com/join/Abcd1234').status,0);
  assert.equal(fs.existsSync(f.output),false);
});
