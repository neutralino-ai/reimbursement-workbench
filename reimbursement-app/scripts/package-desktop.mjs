import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const target = args.includes('--mac') ? 'mac' : 'win';
const arch = args.includes('--arm64') ? Arch.arm64 : Arch.x64;
// Keep the staging directory outside the pnpm workspace. Otherwise
// electron-builder can discover the repository's node_modules and copy them
// into the desktop asar even though the client has no runtime dependencies.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-desktop-stage-'));
const output = path.resolve(project, '..', 'output', 'desktop', manifest.version);
const copy = (source, destination) => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Only regular build files may be packaged: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};

// Build from an explicit allowlist in a fresh staging directory. The repository,
// server, originals, local backups and Agent credentials are never packager input.
const desktopFiles = ['main.cjs', 'preload.cjs', 'policy.cjs', 'updates.cjs'];
for (const filename of desktopFiles) copy(path.join(project, 'desktop', filename), path.join(stage, 'desktop', filename));
for (const filename of ['index.html', 'frontend-config.json']) copy(path.join(project, 'dist', filename), path.join(stage, 'dist', filename));
const config = JSON.parse(fs.readFileSync(path.join(stage, 'dist', 'frontend-config.json'), 'utf8'));
if (Object.keys(config).length !== 1 || typeof config.apiBaseUrl !== 'string') throw new Error('Public frontend configuration must contain only apiBaseUrl.');
for (const filename of fs.readdirSync(path.join(project, 'dist', 'assets'))) {
  if (!/^[\w.-]+\.(?:js|css|svg|png|jpg|jpeg|webp|woff2?)$/.test(filename)) throw new Error(`Unexpected frontend asset: ${filename}`);
  copy(path.join(project, 'dist', 'assets', filename), path.join(stage, 'dist', 'assets', filename));
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'reimbursement-desktop', version: manifest.version, private: true, packageManager: 'pnpm@11.19.0',
  description: 'Desktop client for the reimbursement API', author: 'Reimbursement Workbench',
  main: 'desktop/main.cjs',
}, null, 2) + '\n');

const artifacts = await build({
  projectDir: stage,
  targets: (target === 'mac' ? Platform.MAC : Platform.WINDOWS).createTarget(target === 'mac' ? ['dmg', 'zip'] : ['nsis'], arch),
  config: {
    appId: 'cn.neutrinophysics.reimbursement',
    productName: 'Reimbursement',
    executableName: 'Reimbursement',
    electronVersion: manifest.devDependencies.electron,
    directories: { output, buildResources: path.join(project, 'desktop', 'assets') },
    files: ['package.json', 'desktop/*.cjs', 'dist/index.html', 'dist/frontend-config.json', 'dist/assets/**/*'],
    asar: true,
    npmRebuild: false,
    publish: null,
    artifactName: 'Reimbursement-${version}-${os}-${arch}.${ext}',
    win: { icon: path.join(project, 'desktop', 'assets', 'icon.ico'), signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '报销工作台', deleteAppDataOnUninstall: false },
    mac: { icon: path.join(project, 'desktop', 'assets', 'icon.icns'), category: 'public.app-category.finance', identity: '-', notarize: false },
  },
});
console.log(JSON.stringify({ artifacts, stagedFiles: desktopFiles.length, dataBundled: false }));
