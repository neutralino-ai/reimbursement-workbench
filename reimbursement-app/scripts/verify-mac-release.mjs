import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const arch=process.argv.includes('--arm64')?'arm64':'x64';
const output=path.resolve(root,'../output/desktop',version);
const app=path.join(output,arch==='arm64'?'mac-arm64':'mac','Reimbursement.app');
function run(program,args){
  const result=spawnSync(program,args,{encoding:'utf8',env:{...process.env,DEVELOPER_DIR:process.env.DEVELOPER_DIR||'/Applications/Xcode.app/Contents/Developer'}});
  if(result.error)throw result.error;
  assert.equal(result.status,0,`${program} verification failed: ${result.stderr || result.stdout}`);
  return result.stdout+result.stderr;
}
run('codesign',['--verify','--deep','--strict',app]);
const signature=run('codesign',['-dv','--verbose=4',app]);
assert.match(signature,/Authority=Developer ID Application:/,'Public release requires Developer ID');
assert.match(signature,/flags=.*runtime/,'Hardened runtime required');
assert.match(signature,/Timestamp=/,'Secure timestamp missing');
assert.doesNotMatch(signature,/Signature=adhoc/);
run('xcrun',['stapler','validate',app]);
assert.match(run('spctl',['--assess','--type','execute','--verbose=2',app]),/source=Notarized Developer ID/);
const audit={version,arch,developerID:true,hardenedRuntime:true,notarized:true,gatekeeperAccepted:true};
fs.writeFileSync(path.join(output,`mac-${arch}-release-audit.json`),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify(audit));
