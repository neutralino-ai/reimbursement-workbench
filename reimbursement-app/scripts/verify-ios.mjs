import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(app,'package.json'))).version;
const icon=fs.readFileSync(path.join(app,'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
assert.equal(icon.subarray(0,8).toString('hex'),'89504e470d0a1a0a','App Store icon must be PNG');
assert.equal(icon.readUInt32BE(16),1024);assert.equal(icon.readUInt32BE(20),1024);
assert.equal(icon[25],2,'App Store icon must be RGB without an alpha channel');
for(let offset=8;offset<icon.length;offset+=12+icon.readUInt32BE(offset))assert.notEqual(icon.toString('ascii',offset+4,offset+8),'tRNS','App Store icon cannot contain transparency');
const project=fs.readFileSync(path.join(app,'ios/App/App.xcodeproj/project.pbxproj'),'utf8');
assert.deepEqual([...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match=>match[1]),[version,version],'iOS Debug/Release versions must match package.json');
const bundle=path.join(app,'ios/App/App/public');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(dir,entry.name);
  assert.ok(!entry.isSymbolicLink(),'No symlinks in iOS web bundle');
  return entry.isDirectory()?walk(file):[file];
});
for(const file of walk(bundle)){
  const relative=path.relative(bundle,file).replaceAll('\\','/');
  assert.ok(/^(index\.html|frontend-config\.json|cordova(?:_plugins)?\.js|assets\/[\w.-]+\.(js|css|svg|png|jpg|jpeg|webp|woff2?))$/.test(relative),`Unexpected bundle file: ${relative}`);
  if(relative==='cordova.js'||relative==='cordova_plugins.js')continue;
  assert.deepEqual(fs.readFileSync(file),fs.readFileSync(path.join(app,'dist',relative)),`Stale iOS asset: ${relative}`);
}
for(const file of walk(path.join(app,'dist')))assert.ok(fs.existsSync(path.join(bundle,path.relative(path.join(app,'dist'),file))),'Missing iOS asset');
const config=JSON.parse(fs.readFileSync(path.join(bundle,'frontend-config.json')));
assert.deepEqual(Object.keys(config),['apiBaseUrl']);
const endpoint=new URL(config.apiBaseUrl);
assert.equal(endpoint.protocol,'https:');
assert.ok(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'Public API URL must not contain secrets');
const capacitor=JSON.parse(fs.readFileSync(path.join(app,'ios/App/App/capacitor.config.json')));
assert.equal(capacitor.server?.url,undefined,'No hosted frontend / live reload in shipped app');
assert.equal(capacitor.server?.iosScheme,'capacitor');
assert.equal(capacitor.server?.hostname,'localhost');
assert.equal(capacitor.plugins?.CapacitorHttp?.enabled,false,'Use standard HTTPS fetch and CORS');
const plist=fs.readFileSync(path.join(app,'ios/App/App/Info.plist'),'utf8');
assert.ok(!plist.includes('NSAllowsArbitraryLoads'),'No TLS exceptions');
assert.ok(plist.includes('NSMicrophoneUsageDescription')&&plist.includes('NSSpeechRecognitionUsageDescription'));
console.log('iOS bundle verified: frontend only, current assets, HTTPS, no native HTTP bypass.');
