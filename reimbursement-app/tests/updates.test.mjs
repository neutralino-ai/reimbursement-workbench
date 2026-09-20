import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {newer,releaseInfo,checkForUpdates,REPOSITORY}=createRequire(import.meta.url)('../desktop/updates.cjs');
const base=`https://github.com/${REPOSITORY}`;
const release={tag_name:'v0.2.0',draft:false,prerelease:false,html_url:`${base}/releases/tag/v0.2.0`,body:'Changes',assets:[{name:'Reimbursement-0.2.0-win-x64.exe',state:'uploaded',size:42,browser_download_url:`${base}/releases/download/v0.2.0/Reimbursement-0.2.0-win-x64.exe`}]};
test('update ordering compares numeric versions and ignores non-stable versions',()=>{
 assert.ok(newer('v0.10.0','0.9.9'));assert.equal(newer('0.2.0','0.2.0'),false);assert.equal(newer('0.1.9','0.2.0'),false);
 assert.throws(()=>newer('0.3.0-beta','0.2.0'));assert.throws(()=>releaseInfo({...release,prerelease:true},'0.1.0','win32','x64'));
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
