import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
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
assert.equal(new URL(config.apiBaseUrl).protocol,'https:');
const capacitor=JSON.parse(fs.readFileSync(path.join(app,'ios/App/App/capacitor.config.json')));
assert.equal(capacitor.server?.url,undefined,'No hosted frontend / live reload in shipped app');
assert.equal(capacitor.server?.iosScheme,'capacitor');
assert.equal(capacitor.server?.hostname,'localhost');
assert.equal(capacitor.plugins?.CapacitorHttp?.enabled,false,'Use standard HTTPS fetch and CORS');
const plist=fs.readFileSync(path.join(app,'ios/App/App/Info.plist'),'utf8');
assert.ok(!plist.includes('NSAllowsArbitraryLoads'),'No TLS exceptions');
assert.ok(plist.includes('NSMicrophoneUsageDescription')&&plist.includes('NSSpeechRecognitionUsageDescription'));
console.log('iOS bundle verified: frontend only, current assets, HTTPS, no native HTTP bypass.');
