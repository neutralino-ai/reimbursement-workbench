import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require=createRequire(import.meta.url);
const builder=require.resolve('app-builder-lib',{paths:[require.resolve('electron-builder')]});
const asar=await import(pathToFileURL(require.resolve('@electron/asar',{paths:[builder]})).href);
const version=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8')).version;
const output=path.resolve(project,'../output/desktop',version);
const mac=process.argv.includes('--mac'),arch=process.argv.includes('--arm64')?'arm64':'x64';
const archive=path.join(output,mac?`${arch==='arm64'?'mac-arm64':'mac'}/Reimbursement.app/Contents/Resources/app.asar`:'win-unpacked/resources/app.asar');
const files=['desktop/main.cjs','desktop/preload.cjs','desktop/policy.cjs','desktop/updates.cjs','dist/index.html','dist/frontend-config.json',...fs.readdirSync(path.join(project,'dist/assets')).map(name=>'dist/assets/'+name)];
const approved=new Set([...files,'package.json']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const verified=[];
for(const item of asar.listPackage(archive)) {
  const name=item.replace(/^[\\/]/,'').replaceAll('\\','/');
  const nativeName=path.normalize(name);
  const stat=asar.statFile(archive,nativeName);
  if(stat.files)continue;
  assert.ok(approved.has(name),`Unexpected packaged file: ${name}`);
  assert.ok(!stat.link&&!stat.unpacked,`Unexpected external dependency: ${name}`);
  const bytes=asar.extractFile(archive,nativeName);
  if(name==='package.json') {
    const manifest=JSON.parse(bytes);
    assert.equal(manifest.main,'desktop/main.cjs');
    assert.equal(manifest.version,version);
    assert.ok(!Object.keys(manifest.dependencies||{}).length);
  } else assert.equal(sha(bytes),sha(fs.readFileSync(path.join(project,name))),`Stale packaged file: ${name}`);
  verified.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
}
assert.equal(verified.length,approved.size);
const artifact=path.join(output,`Reimbursement-${version}-${mac?'mac':'win'}-${arch}.${mac?'zip':'exe'}`);
const audit={platform:mac?'darwin':'win32',arch,version,artifact,bytes:fs.statSync(artifact).size,sha256:sha(fs.readFileSync(artifact)),verifiedFiles:verified,financialDataIncluded:false,backendIncluded:false};
fs.writeFileSync(path.join(output,`${mac?'mac':'windows'}-${arch}-build-audit.json`),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({verifiedFiles:verified.length,bytes:audit.bytes,sha256:audit.sha256,financialDataIncluded:false,backendIncluded:false}));
