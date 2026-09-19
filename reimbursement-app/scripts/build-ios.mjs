import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
if(process.platform!=='darwin')throw new Error('原生 iOS 编译需要 Mac 和 Xcode 26+。Windows 可运行 pnpm ios:sync。');
for(const args of [
  ['-version'],
  ['-project','ios/App/App.xcodeproj','-scheme','App','-configuration','Debug','-sdk','iphonesimulator','-destination','generic/platform=iOS Simulator','-derivedDataPath','ios/DerivedData','CODE_SIGNING_ALLOWED=NO','build'],
]){
  const result=spawnSync('xcodebuild',args,{cwd,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
