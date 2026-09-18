import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/index.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('dev file server cannot bypass private data and legacy material APIs', async () => {
  // Keep synthetic data under the Vite root: an external temp directory would
  // already be denied by Vite's default allow list and miss the regression.
  const folder = mkdtempSync(path.join(appDir, 'http-dev-security-'));
  const dataDir = path.join(folder, 'custom-ledger');
  const legacyDir = path.join(folder, 'custom-archive');
  const appData = path.join(legacyDir, 'private-data', 'AppData');
  const marker = 'SYNTHETIC_PRIVATE_FINANCIAL_DATA_DO_NOT_SERVE';
  let application;
  try {
    mkdirSync(path.join(appData, 'materials'), {recursive:true});
    mkdirSync(dataDir, {recursive:true});
    writeFileSync(path.join(appData, 'workspace.json'), JSON.stringify({
      schemaVersion:3,accounts:[],records:[],inbox:[],reviews:[],
      privateMarker:marker,
      reconciliation:{arpPayments:[],vendorPayments:[],allocations:[],confirmedClaimRecordIDs:[]},
    }));
    const customSecret = path.join(dataDir, 'unlisted-evidence.json');
    writeFileSync(customSecret, JSON.stringify({marker}));
    const protectedFiles = [customSecret, path.join(appData, 'workspace.json')];
    for (const name of ['data', 'materials', 'imports']) {
      const directory = path.join(folder, 'other-files', name);
      mkdirSync(directory, {recursive:true});
      const file = path.join(directory, 'private.json');
      writeFileSync(file, JSON.stringify({marker}));
      protectedFiles.push(file);
    }
    // A non-sensitive control verifies that the Vite static path is active.
    const publicFile = path.join(folder, 'public-control.txt');
    writeFileSync(publicFile, 'synthetic public control');

    application = await createApp({dev:true, dataDir, legacyDir});
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${application.server.address().port}`;
    const rootedURL = file => '/' + path.relative(appDir, file).replaceAll('\\', '/');
    const absoluteURL = file => '/@fs/' + file.replaceAll('\\', '/');

    const control = await fetch(base + rootedURL(publicFile));
    assert.equal(control.status, 200);
    assert.equal(await control.text(), 'synthetic public control');
    const workspace = await fetch(base + '/api/workspace');
    assert.equal(workspace.status, 200);
    assert.equal((await workspace.json()).records.length, 0);

    for (const file of protectedFiles) {
      for (const resource of [rootedURL(file), absoluteURL(file), rootedURL(file) + '?raw']) {
        const response = await fetch(base + resource);
        const responseText = await response.text();
        assert.equal(response.status, 403, `Private file exposed through ${resource}`);
        assert.ok(!responseText.includes(marker), `Private content leaked through ${resource}`);
      }
    }
    const unknownMaterial = await fetch(base + '/api/materials/unlisted-evidence.json');
    assert.equal(unknownMaterial.status, 404);
  } finally {
    if (application) await application.close();
    const resolvedFolder = path.resolve(folder);
    assert.equal(path.dirname(resolvedFolder), appDir);
    assert.ok(path.basename(resolvedFolder).startsWith('http-dev-security-'));
    rmSync(resolvedFolder, {recursive:true, force:true});
  }
});
