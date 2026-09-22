import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// Exercise the actual compiled SceneDelegate and WKWebView -> Swift bridge.
// Only a disposable copy of the simulator .app receives the probe page;
// the device archive, source web bundle and user's simulator are untouched.
if(process.platform!=='darwin')throw new Error('Requires Xcode and an iOS Simulator runtime');
const appRoot=fileURLToPath(new URL('..',import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'))).version;
const bundle='cn.neutrinophysics.reimbursement';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'reimbursement-plugin-smoke-'));
let device;
function run(args,{allowFailure=false,timeout=180000}={}){
  const r=spawnSync('xcrun',['simctl',...args],{encoding:'utf8',timeout});
  if(!allowFailure&&(r.error||r.status!==0))throw new Error(`simctl ${args[0]}: ${r.error?.message||r.stderr||'failed'}\n${r.stdout?.slice(-2000)||''}`);
  return r.stdout?.trim()||'';
}
try{
  const built=path.resolve(appRoot,'../output/ios',version,'simulator-derived-data/Build/Products/Release-iphonesimulator/App.app');
  assert.ok(fs.existsSync(built),'Run pnpm ios:build first');
  const copy=path.join(work,'App.app');
  fs.cpSync(built,copy,{recursive:true});
  const probe=`
    const cap=window.Capacitor;
    const call=(plugin,method,options={})=>cap.nativePromise(plugin,method,options);
    async function expectReject(plugin,method,options,message){
      try{await call(plugin,method,options);}catch(error){
        if(error.message.includes(message))return;
        throw error;
      }
      throw new Error(plugin+' accepted invalid input');
    }
    (async()=>{
      for(const name of ['MobileSettings','SpeechInput','ReimbursementFiles']){
        if(!cap.isPluginAvailable(name))throw new Error(name+' not registered');
      }
      const initial=await call('MobileSettings','getConnection');
      if(initial.apiBaseUrl!=='')throw new Error('Expected a clean simulator');
      const url='https://ios-plugin-smoke.invalid/roundtrip';
      await call('MobileSettings','saveConnection',{apiBaseUrl:url});
      if((await call('MobileSettings','getConnection')).apiBaseUrl!==url)throw new Error('Connection persistence failed');
      await expectReject('MobileSettings','saveConnection',{apiBaseUrl:'http://insecure.invalid'},'HTTPS');
      await expectReject('SpeechInput','start',{id:'invalid',locale:'zh-CN'},'录音参数无效');
      await call('SpeechInput','cancel',{id:'00000000-0000-4000-8000-000000000001'});
      await expectReject('ReimbursementFiles','present',{filename:'test.pdf',base64:'',mode:'preview'},'此文件无法');
      await call('MobileSettings','saveConnection',{apiBaseUrl:'https://ios-plugin-smoke.invalid/passed'});
    })().catch(error=>console.error('NATIVE_PLUGIN_SMOKE_FAILED',String(error)));
  `;
  fs.writeFileSync(path.join(copy,'public/index.html'),`<!doctype html><meta charset="UTF-8"><script>${probe}</script>`);
  const devices=JSON.parse(run(['list','devices','available','--json'])).devices;
  const candidates=Object.entries(devices).flatMap(([runtime,items])=>items.filter(x=>x.name.startsWith('iPhone')&&x.deviceTypeIdentifier&&/\.iOS-/.test(runtime)).map(x=>({...x,runtime})));
  assert.ok(candidates.length,'An available iPhone simulator is required');
  const template=candidates[0];
  device=run(['create',`Reimbursement plugins ${Date.now()}`,template.deviceTypeIdentifier,template.runtime]);
  assert.match(device,/^[A-F0-9-]{36}$/i);
  run(['boot',device]);
  // A freshly created iOS runtime can need more than three minutes on hosted Macs.
  // Wait for boot completion before installing; the native probe is still mandatory.
  console.log('Waiting for fresh simulator boot:',template.runtime);
  run(['bootstatus',device,'-b'],{timeout:480000});
  run(['install',device,copy]);run(['launch',device,bundle]);
  const container=run(['get_app_container',device,bundle,'data']);
  const prefs=path.join(container,'Library/Preferences',`${bundle}.plist`);
  let passed=false;
  for(let attempt=0;attempt<60;attempt++){
    if(fs.existsSync(prefs)){
      const r=spawnSync('plutil',['-convert','json','-o','-',prefs],{encoding:'utf8'});
      if(r.status===0&&JSON.parse(r.stdout)['reimbursement.apiBaseUrl']==='https://ios-plugin-smoke.invalid/passed'){passed=true;break;}
    }
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  assert.ok(passed,'Native plugin probe did not finish: check SceneDelegate startup and bridge registration');
  console.log('PASS: simulator scene startup; MobileSettings get/save + HTTPS validation; SpeechInput dispatch; ReimbursementFiles dispatch.');
}finally{
  if(device){run(['shutdown',device],{allowFailure:true});run(['delete',device],{allowFailure:true});}
  fs.rmSync(work,{recursive:true,force:true});
}
