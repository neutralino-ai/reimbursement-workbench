import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {newer,releaseInfo,checkForUpdates,REPOSITORY}=createRequire(import.meta.url)('../desktop/updates.cjs');
const base=`https://github.com/${REPOSITORY}`;
const release={tag_name:'v0.2.0',draft:false,prerelease:false,html_url:`${base}/releases/tag/v0.2.0`,body:'Changes',assets:[{name:'Reimbursement-0.2.0-win-x64.exe',state:'uploaded',size:42,browser_download_url:`${base}/releases/download/v0.2.0/Reimbursement-0.2.0-win-x64.exe`}]};
const bytes=Buffer.from('Synthetic update, never execute this file.');
release.assets[0].size=bytes.length;
release.assets[0].digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
const {UpdateClient}=createRequire(import.meta.url)('../desktop/updates.cjs');
test('update ordering compares numeric versions and ignores non-stable versions',()=>{
 assert.ok(newer('v0.10.0','0.9.9'));assert.equal(newer('0.2.0','0.2.0'),false);assert.equal(newer('0.1.9','0.2.0'),false);
 assert.throws(()=>newer('0.3.0-beta','0.2.0'));assert.throws(()=>releaseInfo({...release,prerelease:true},'0.1.0','win32','x64'));
});

test('Mac picks an exact DMG architecture, and ambiguous or unverified installers stay unavailable',()=>{
 for(const arch of ['x64','arm64']){
  const name=`Reimbursement-0.2.0-mac-${arch}.dmg`,asset={...release.assets[0],name,browser_download_url:`${base}/releases/download/v0.2.0/${name}`};
  assert.equal(releaseInfo({...release,assets:[asset]},'0.1.0','darwin',arch).assetName,name);
 }
 for(const change of [{digest:''},{size:301*1024*1024},{state:'new'},{size:1.5}])assert.equal(releaseInfo({...release,assets:[{...release.assets[0],...change}]},'0.1.0','win32','x64').downloadUrl,null);
 assert.equal(releaseInfo({...release,assets:[release.assets[0],release.assets[0]]},'0.1.0','win32','x64').downloadUrl,null);
 assert.equal(releaseInfo(release,'0.1.0','win32','arm64').downloadUrl,null);
});

async function fixture(t,fetchAsset){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reimbursement-update-')),opened=[],calls=[];
 t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('reimbursement-update-'));await fs.rm(directory,{recursive:true,force:true});});
 const client=new UpdateClient({currentVersion:'0.1.0',platform:'win32',arch:'x64',directory,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.startsWith('https://api.github.com/'))return Response.json(release);
  return fetchAsset?fetchAsset(url,options):new Response(bytes,{headers:{'content-length':String(bytes.length)}});
 },opener:async filename=>{opened.push(filename);return '';}});
 return {client,directory,opened,calls};
}
test('in-app download verifies data and installation, caches exact bytes, and never sends API credentials',async t=>{
 const f=await fixture(t,url=>url.startsWith(base)?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/synthetic'}}):new Response(bytes));
 assert.equal((await f.client.check()).state,'available');await assert.rejects(f.client.install());
 const downloaded=await f.client.download();assert.equal(downloaded.state,'ready');assert.equal(downloaded.downloaded,bytes.length);assert.equal(downloaded.busy,false);
 assert.deepEqual(await fs.readFile(f.client.file),bytes);assert.equal((await f.client.install()).state,'opened');assert.equal(f.opened.length,1);
 await f.client.check();const calls=f.calls.length;assert.equal((await f.client.download()).state,'ready');assert.equal(f.calls.length,calls,'verified cache needs no second download');
 await fs.writeFile(f.client.file,'corrupt');assert.equal((await f.client.install()).state,'error');assert.equal(f.opened.length,1);assert.equal(f.client.info().canInstall,false);
 assert.ok(f.calls.every(c=>c.options.credentials==='omit'&&!c.options.headers?.Authorization&&c.options.redirect!=='follow'));
});
test('unsafe redirects, wrong hashes, lengths and network errors never leave executable partials',async t=>{
 for(const response of [
  ()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),
  ()=>new Response(null,{status:302,headers:{location:'https://user:pass@release-assets.githubusercontent.com/f'}}),
  ()=>new Response(null,{status:302,headers:{location:'https://github.com.evil.test/f'}}),
  ()=>new Response(Buffer.alloc(bytes.length)),()=>new Response(bytes.subarray(1)),()=>new Response(Buffer.concat([bytes,bytes])),
  ()=>new Response(bytes,{headers:{'content-length':'99'}}),()=>{throw new Error('private network diagnostic');},
 ]){
  const f=await fixture(t,response);await f.client.check();const result=await f.client.download();
  assert.equal(result.state,'error');assert.ok(!result.error.includes('private network diagnostic'));assert.equal(result.canInstall,false);
  await assert.rejects(f.client.install());assert.deepEqual(await fs.readdir(f.directory),[]);assert.equal(f.opened.length,0);
 }
});
test('progress is readable during download, duplicate work is blocked, cancel cleans up and retry succeeds',async t=>{
 let streamController,signal,started;const reached=new Promise(r=>started=r);let delayed=true;
 const f=await fixture(t,(_url,options)=>{
  if(!delayed)return new Response(bytes);
  signal=options.signal;
  return new Response(new ReadableStream({start(controller){streamController=controller;controller.enqueue(bytes.subarray(0,10));signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});started();}}));
 });
 await f.client.check();const downloading=f.client.download();await reached;
 for(let i=0;i<100&&f.client.info().downloaded!==10;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.client.info().downloaded,10);assert.equal(f.client.info().busy,true);
 await assert.rejects(f.client.check(),/正在进行/);await assert.rejects(f.client.download(),/正在进行/);
 f.client.cancel();assert.equal((await downloading).state,'cancelled');assert.equal(signal.aborted,true);assert.deepEqual(await fs.readdir(f.directory),[]);
 delayed=false;assert.equal((await f.client.download()).state,'ready');assert.ok(streamController);
});
test('missing release, bounded metadata and open failures offer a recoverable state',async t=>{
 const f=await fixture(t);f.client.fetchImpl=async()=>new Response(null,{status:404});assert.equal((await f.client.check()).state,'unavailable');
 f.client.fetchImpl=async()=>new Response('x'.repeat(1024*1024+1));assert.equal((await f.client.check()).state,'error');assert.match(f.client.info().error,/过大/);
 const g=await fixture(t);await g.client.check();await g.client.download();g.client.opener=async()=>'OS failure';
 assert.equal((await g.client.install()).state,'error');assert.equal(g.client.info().canInstall,true);
 g.client.opener=async()=>'';assert.equal((await g.client.install()).state,'opened');
});
test('only exact project and platform assets become update download links',()=>{
 const update=releaseInfo(release,'0.1.0','win32','x64');assert.equal(update.status,'available');assert.equal(update.assetName,release.assets[0].name);
 assert.equal(releaseInfo(release,'0.2.0','win32','x64').status,'current');
 assert.equal(releaseInfo(release,'0.2.1','win32','x64').status,'ahead');
 assert.equal(releaseInfo(release,'0.1.0','darwin','arm64').downloadUrl,null);
 assert.throws(()=>releaseInfo({...release,html_url:'https://evil.test/download'},'0.1.0','win32','x64'));
 assert.equal(releaseInfo({...release,assets:[{...release.assets[0],browser_download_url:'https://evil.test/installer.exe'}]},'0.1.0','win32','x64').downloadUrl,null);
});
test('update requests are anonymous and distinguish no release, rate limits and connection failure',async()=>{
 const fetchImpl=async(url,options)=>{assert.equal(url,`https://api.github.com/repos/${REPOSITORY}/releases/latest`);assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'error');return new Response(JSON.stringify(release));};
 assert.equal((await checkForUpdates({currentVersion:'0.1.0',platform:'win32',arch:'x64',fetchImpl})).status,'available');
 assert.equal((await checkForUpdates({currentVersion:'0.1.0',fetchImpl:async()=>new Response('',{status:404})})).status,'unavailable');
 await assert.rejects(checkForUpdates({currentVersion:'0.1.0',fetchImpl:async()=>new Response('',{status:403,headers:{'x-ratelimit-remaining':'0'}})}),/限额/);
 await assert.rejects(checkForUpdates({currentVersion:'0.1.0',fetchImpl:async()=>{throw new Error('private diagnostic');}}),/无法连接 GitHub/);
});
