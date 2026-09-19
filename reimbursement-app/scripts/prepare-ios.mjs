import fs from 'node:fs';
// Capacitor 8 emits swift-tools-version 5.9 with .v18 from the app target.
// The string form expresses the same deployment target in PackageDescription 5.9.
const file=new URL('../ios/App/CapApp-SPM/Package.swift',import.meta.url);
const source=fs.readFileSync(file,'utf8');
fs.writeFileSync(file,source.replace('.iOS(.v18)', '.iOS("18.0")'));
