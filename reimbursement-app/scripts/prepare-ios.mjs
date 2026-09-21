import fs from 'node:fs';
import {syncIOSVersion} from './release-policy.mjs';
// Capacitor 8 emits swift-tools-version 5.9 with .v18 from the app target.
// The string form expresses the same deployment target in PackageDescription 5.9.
const file=new URL('../ios/App/CapApp-SPM/Package.swift',import.meta.url);
const source=fs.readFileSync(file,'utf8');
fs.writeFileSync(file,source.replace('.iOS(.v18)', '.iOS("18.0")'));
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const project = new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url);
fs.writeFileSync(project, syncIOSVersion(fs.readFileSync(project, 'utf8'), manifest.version, process.env.IOS_BUILD_NUMBER));
console.log(`iOS marketing version synchronized with package.json: ${manifest.version}`);
