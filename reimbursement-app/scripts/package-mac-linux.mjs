import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

// This helper operates on a supplied, frontend-only source directory. Install
// @electron/packager@20.3.0 separately in --tools-dir, never in the app stage.
if(process.platform!=='linux')throw new Error('Run this unsigned cross-package helper on Linux.');
const args=process.argv.slice(2);
const value=flag=>{const at=args.indexOf(flag);if(at<0||!args[at+1]||args[at+1].startsWith('--'))throw new Error(`Missing ${flag}`);return path.resolve(args[at+1]);};
const source=value('--source');
const work=value('--work-dir');
const toolsDir=value('--tools-dir');
const electronZipDir=args.includes('--electron-zip-dir')?value('--electron-zip-dir'):undefined;
const packagerManifest=JSON.parse(fs.readFileSync(path.join(toolsDir,'node_modules/@electron/packager/package.json'),'utf8'));
assert.equal(packagerManifest.version,'20.3.0','Use the pinned, reviewed packager version.');
const toolRequire=createRequire(path.join(toolsDir,'package.json'));
const packagerEntry=toolRequire.resolve('@electron/packager');
const {packager}=await import(pathToFileURL(packagerEntry).href);
const packagerRequire=createRequire(packagerEntry);
const asar=await import(pathToFileURL(packagerRequire.resolve('@electron/asar')).href);

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function input(relative) {
  assert.ok(!path.isAbsolute(relative)&&!relative.split('/').some(part=>!part||part==='..'||part==='.'||part.startsWith('.')));
  let current=source;
  assert.equal(fs.lstatSync(current).isSymbolicLink(),false);
  for(const part of relative.split('/')){current=path.join(current,part);assert.equal(fs.lstatSync(current).isSymbolicLink(),false);}
  assert.ok(fs.realpathSync(current).startsWith(fs.realpathSync(source)+path.sep));
  assert.ok(fs.statSync(current).isFile());
  return fs.readFileSync(current);
}
const originalManifest=JSON.parse(input('package.json'));
assert.match(originalManifest.version,/^\d+\.\d+\.\d+$/);
const version=originalManifest.version;
const electronVersion=originalManifest.devDependencies?.electron||originalManifest.electronVersion;
assert.equal(electronVersion,'44.4.1','Use the reviewed Electron runtime.');
const runtimeArchives=[];
if(electronZipDir){
  const sums=fs.readFileSync(path.join(electronZipDir,'SHASUMS256.txt'),'utf8');
  for(const arch of ['arm64','x64']){
    const filename=`electron-v${electronVersion}-darwin-${arch}.zip`;
    const match=sums.split(/\r?\n/).find(line=>line.trim().split(/\s+/).at(-1)?.replace(/^\*/,'')===filename);
    assert.ok(match,`Official checksum missing for ${filename}`);
    const digest=sha256(fs.readFileSync(path.join(electronZipDir,filename)));
    assert.equal(digest,match.trim().split(/\s+/)[0]);
    runtimeArchives.push({filename,sha256:digest});
  }
}
const config=JSON.parse(input('dist/frontend-config.json'));
assert.deepEqual(Object.keys(config),['apiBaseUrl']);
const sourcePolicy=createRequire(path.join(source,'package.json'))('./desktop/policy.cjs');
sourcePolicy.validateConnection(config);
const assets=fs.readdirSync(path.join(source,'dist/assets'));
assert.ok(assets.length>0);
for(const name of assets)assert.match(name,/^[\w.-]+\.(?:js|css|svg|png|jpg|jpeg|webp|woff2?)$/);
const sourceFiles=['desktop/main.cjs','desktop/preload.cjs','desktop/policy.cjs','desktop/updates.cjs','dist/index.html','dist/frontend-config.json',...assets.map(name=>'dist/assets/'+name)];

fs.mkdirSync(work,{recursive:true,mode:0o700});
assert.equal(fs.lstatSync(work).isSymbolicLink(),false);
const run=path.join(work,`mac-${Date.now()}-${randomBytes(4).toString('hex')}`);
const stage=path.join(run,'stage');
fs.mkdirSync(stage,{recursive:true,mode:0o700});
const inputManifest=[];
for(const relative of sourceFiles){
  const bytes=input(relative);
  const destination=path.join(stage,relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,bytes,{flag:'wx'});
  inputManifest.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
}
const minimalPackage={name:'reimbursement-desktop',version,private:true,description:'Desktop client for the reimbursement API',author:'Reimbursement Workbench',main:'desktop/main.cjs'};
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(minimalPackage,null,2)+'\n',{flag:'wx'});
const icon=path.join(run,'icon.icns');
fs.writeFileSync(icon,input('desktop/assets/icon.icns'),{flag:'wx'});
sourcePolicy.inspectBundle(stage,{packaged:true});

const artifacts=path.join(run,'artifacts');
fs.mkdirSync(artifacts);
const temporary=path.join(run,'tmp');
fs.mkdirSync(temporary);
const results=[];
for(const arch of ['arm64','x64']){
  const [bundle]=await packager({dir:stage,name:'Reimbursement',platform:'darwin',arch,electronVersion,
    appVersion:version,appBundleId:'cn.neutrinophysics.reimbursement',appCategoryType:'public.app-category.finance',
    icon,asar:true,asarIntegrityDigest:false,prune:false,out:path.join(run,'bundles'),tmpdir:temporary,...(electronZipDir?{electronZipDir}:{download:{cacheRoot:path.join(work,'electron-cache')}})});
  assert.ok(path.resolve(bundle).startsWith(path.join(run,'bundles')+path.sep));
  const app=path.join(bundle,'Reimbursement.app');
  const appAsar=path.join(app,'Contents/Resources/app.asar');
  const approved=new Set([...sourceFiles,'package.json']);
  const entries=asar.listPackage(appAsar);
  const packagedFiles=[];
  for(const entry of entries){
    const relative=entry.replace(/^\//,'');
    const info=asar.statFile(appAsar,relative);
    if(info.files)continue;
    assert.ok(approved.has(relative),`Unexpected packaged source: ${relative}`);
    assert.ok(!info.link&&!info.unpacked,`Unexpected linked or unpacked source: ${relative}`);
    const bytes=asar.extractFile(appAsar,relative);
    if(relative==='package.json'){
      // Packager removes npm-only metadata from the installed package manifest.
      const {private:_private,...installedPackage}=minimalPackage;
      assert.deepEqual(JSON.parse(bytes.toString('utf8')),installedPackage);
    }
    else assert.equal(sha256(bytes),inputManifest.find(file=>file.path===relative).sha256);
    packagedFiles.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
  }
  assert.equal(packagedFiles.length,approved.size);
  const executable=path.join(app,'Contents/MacOS/Reimbursement');
  const magic=fs.readFileSync(executable).subarray(0,8);
  assert.equal(magic.readUInt32LE(0),0xfeedfacf);
  assert.equal(magic.readUInt32LE(4),arch==='arm64'?0x0100000c:0x01000007);
  assert.ok(fs.statSync(executable).mode&0o111);
  let symlinks=0;
  function inspect(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink()){
        const target=fs.realpathSync(file);
        assert.ok(target.startsWith(fs.realpathSync(app)+path.sep),`Escaping framework link: ${file}`);
        symlinks++;
      }else if(entry.isDirectory())inspect(file);
    }
  }
  inspect(app);assert.ok(symlinks>0,'Electron framework symlinks must survive packaging.');
  const zip=path.join(artifacts,`Reimbursement-${version}-mac-${arch}.zip`);
  // The archive lives outside cwd. GNU zip stores symlinks and executable modes;
  // no Windows extraction or archive re-creation occurs on the way to the user.
  execFileSync('zip',['-q','-r','--symlinks',zip,'./'],{cwd:bundle,stdio:'inherit'});
  const bytes=fs.readFileSync(zip);
  results.push({arch,zip,bytes:bytes.length,sha256:sha256(bytes),symlinks,packagedFiles,signed:false,notarized:false,runtimeVerified:false});
  process.stdout.write(JSON.stringify({arch,zip,sha256:sha256(bytes),symlinks})+'\n');
}
const audit={version,electronVersion,packagerVersion:'20.3.0',toolLockSHA256:sha256(fs.readFileSync(path.join(toolsDir,'package-lock.json'))),runtimeArchives,apiBaseUrl:config.apiBaseUrl,inputManifest,results,financialDataIncluded:false,backendIncluded:false};
const auditFile=path.join(artifacts,'mac-build-audit.json');
fs.writeFileSync(auditFile,JSON.stringify(audit,null,2)+'\n');
process.stdout.write(JSON.stringify({auditFile,artifacts})+'\n');
