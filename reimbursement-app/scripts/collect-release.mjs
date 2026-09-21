import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testFlightURL} from './release-policy.mjs';
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version;
const iosURL=testFlightURL(process.env.TESTFLIGHT_PUBLIC_URL);
const source=path.resolve(process.argv[2]),destination=path.resolve(process.argv[3]);
const names=[`Reimbursement-${version}-mac-arm64.dmg`,`Reimbursement-${version}-mac-arm64.zip`,`Reimbursement-${version}-mac-x64.dmg`,`Reimbursement-${version}-mac-x64.zip`,`Reimbursement-${version}-win-x64.exe`];
const found=new Map();
function walk(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name);
  if(item.isSymbolicLink())throw new Error('Unexpected artifact symlink');
  if(item.isDirectory()){walk(file);continue;}
  if(!item.isFile()||!names.includes(item.name)||found.has(item.name))throw new Error('Unexpected or duplicate artifact: '+item.name);
  found.set(item.name,file);
}}
walk(source);
if(found.size!==names.length)throw new Error('All Windows and Mac installer/archive artifacts are required');
fs.mkdirSync(destination,{recursive:true});
const sums=[];
for(const name of names){const bytes=fs.readFileSync(found.get(name));if(bytes.length<1_000_000)throw new Error('Invalid artifact size');fs.copyFileSync(found.get(name),path.join(destination,name),fs.constants.COPYFILE_EXCL);sums.push(createHash('sha256').update(bytes).digest('hex')+'  '+name);}
const installation=Buffer.from(`# 报销工作台 iOS ${version}\n\n通过 TestFlight 安装：[打开安装入口](${iosURL})。\n\n最低 iOS 18，支持 iPhone / iPad。需要已有报销 API 账号；安装客户端不会授予服务器或台账访问权限。TestFlight 中可安装的版本及名额以 Apple 页面为准。\n\n本 Release 不提供可绕过 Apple 分发限制的 IPA。完整 iOS 工程随同本版本源代码公开，位于 reimbursement-app/ios/。\n`);
fs.writeFileSync(path.join(destination,'iOS-Installation.md'),installation,{flag:'wx'});
sums.push(createHash('sha256').update(installation).digest('hex')+'  iOS-Installation.md');
fs.writeFileSync(path.join(destination,'SHA256SUMS'),sums.join('\n')+'\n',{flag:'wx'});
console.log('Collected five desktop assets plus the TestFlight installation entry and checksums.');
