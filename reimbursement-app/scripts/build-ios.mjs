import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'))).version;
const args = process.argv.slice(2);
for (const arg of args) if (!['--archive', '--allow-provisioning-updates'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const archive = args.includes('--archive');
const provisioning = args.includes('--allow-provisioning-updates');
if (process.platform !== 'darwin') throw new Error('原生 iOS 编译需要 Mac 和 Xcode 26+。其他平台可运行 pnpm ios:sync。');
if (provisioning && !archive) throw new Error('Provisioning updates apply only to an explicitly requested device archive.');
if (archive && !/^[A-Z0-9]{10}$/.test(process.env.DEVELOPMENT_TEAM || '')) throw new Error('Set DEVELOPMENT_TEAM for a device archive.');
if (archive && !/^[1-9]\d{0,8}$/.test(process.env.IOS_BUILD_NUMBER || '')) throw new Error('Set an explicit IOS_BUILD_NUMBER for TestFlight archives.');
const env = {...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer'};
function run(program, argv) {
  const result = spawnSync(program, argv, {cwd, env, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
// Rebuild and verify web resources before every native build, including archives.
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--base=/']);
run(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'ios']);
run(process.execPath, ['scripts/prepare-ios.mjs']);
run(process.execPath, ['scripts/verify-ios.mjs']);
run('xcodebuild', ['-version']);
const output = path.resolve(cwd, '../output/ios', version);
const build = ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release', '-sdk', archive ? 'iphoneos' : 'iphonesimulator', '-destination', `generic/platform=${archive ? 'iOS' : 'iOS Simulator'}`, '-derivedDataPath', path.join(output, archive ? 'device-derived-data' : 'simulator-derived-data')];
if (archive) {
  const archivePath = path.join(output, `Reimbursement-${version}-${process.env.IOS_BUILD_NUMBER}.xcarchive`);
  if (fs.existsSync(archivePath)) throw new Error('Archive already exists; choose a new build number instead of overwriting.');
  build.push(`DEVELOPMENT_TEAM=${process.env.DEVELOPMENT_TEAM}`, '-archivePath', archivePath);
  if (provisioning) build.push('-allowProvisioningUpdates');
  build.push('archive');
} else build.push('CODE_SIGNING_ALLOWED=NO', 'build');
run('xcodebuild', build);
console.log(archive ? 'Archive created. Upload through Xcode Organizer to App Store Connect; this is not a public IPA.' : 'iOS Simulator Release build complete.');
