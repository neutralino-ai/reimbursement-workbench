import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {iosBundleID,validateIOSProfile} from './ios-signing-policy.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const bundleID=iosBundleID;
function run(command,args,options={}){
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8',...options});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function required(name,pattern){
  const value=process.env[name];
  if(!value || (pattern&&!pattern.test(value)))throw new Error(`Missing or invalid ${name}`);
  return value;
}
const mode=process.argv[2];
if(process.platform!=='darwin')throw new Error('Signed iOS distribution requires a macOS runner.');
const team=required('DEVELOPMENT_TEAM',/^[A-Z0-9]{10}$/);
const buildNumber=required('IOS_BUILD_NUMBER',/^[1-9]\d{0,8}$/);
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const output=path.resolve(root,'../output/ios',version);
const archive=path.join(output,`Reimbursement-${version}-${buildNumber}.xcarchive`);
const exportPath=path.join(output,`export-${buildNumber}`);

if(mode==='export'){
  const uuid=required('IOS_PROFILE_UUID',/^[A-Fa-f0-9-]{36}$/);
  const app=path.join(archive,'Products/Applications/App.app');
  run('codesign',['--verify','--deep','--strict',app]);
  const info=JSON.parse(run('plutil',['-convert','json','-o','-',path.join(app,'Info.plist')]));
  if(info.CFBundleIdentifier!==bundleID || info.CFBundleShortVersionString!==version || info.CFBundleVersion!==buildNumber)throw new Error('Archive identity/version mismatch');
  const profile=run('security',['cms','-D','-i',path.join(app,'embedded.mobileprovision')]);
  const plistFile=path.join(output,'archive-profile.plist');
  fs.writeFileSync(plistFile,profile,{mode:0o600});
  const provision=JSON.parse(run('python3',['-c','import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),default=str))',plistFile]));
  validateIOSProfile(provision,team,uuid);
  const options={method:'app-store-connect',destination:'export',teamID:team,signingStyle:'manual',signingCertificate:'Apple Distribution',provisioningProfiles:{[bundleID]:uuid},uploadSymbols:true,manageAppVersionAndBuildNumber:false};
  const optionsPath=path.join(output,'ExportOptions.plist');
  fs.writeFileSync(optionsPath,JSON.stringify(options));
  run('plutil',['-convert','xml1',optionsPath]);
  run('xcodebuild',['-exportArchive','-archivePath',archive,'-exportPath',exportPath,'-exportOptionsPlist',optionsPath],{stdio:'inherit'});
  if(!fs.existsSync(path.join(exportPath,'App.ipa')))throw new Error('Export did not produce App.ipa');
  console.log(JSON.stringify({version,buildNumber,appStoreProfile:true,exported:true}));
}else if(mode==='upload'){
  const keyID=required('APPLE_API_KEY_ID',/^[A-Z0-9]{10}$/);
  const issuer=required('APPLE_API_ISSUER',/^[a-f0-9-]{36}$/i);
  const key=required('APPLE_API_KEY');
  const keyDir=fs.mkdtempSync(path.join(os.tmpdir(),'reimbursement-upload-key-'));
  try{
    fs.copyFileSync(key,path.join(keyDir,`AuthKey_${keyID}.p8`));
    fs.chmodSync(path.join(keyDir,`AuthKey_${keyID}.p8`),0o600);
    run('xcrun',['altool','--upload-app','--type','ios','--file',path.join(exportPath,'App.ipa'),'--apiKey',keyID,'--apiIssuer',issuer],{env:{...process.env,API_PRIVATE_KEYS_DIR:keyDir},stdio:'inherit'});
  }finally{fs.rmSync(keyDir,{recursive:true,force:true});}
  console.log('Uploaded to App Store Connect; Apple processing and TestFlight availability must be checked separately.');
}else throw new Error('Expected export or upload');
