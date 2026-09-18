// Temporary fictional data for browser acceptance checks. Never reads production data.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';

const PORT = 4318;
const PREFIX = 'reimbursement-workflow-fictional-demo-';
const markerValue = randomUUID();
const tempRoot = realpathSync(tmpdir());
const fixtureRoot = mkdtempSync(path.join(tempRoot, PREFIX));
const markerFile = path.join(fixtureRoot, '.fictional-workflow-fixture');
writeFileSync(markerFile, markerValue, { flag: 'wx' });
const legacyDir = path.join(fixtureRoot, 'synthetic-legacy');
const dataDir = path.join(fixtureRoot, 'synthetic-data');
const appData = path.join(legacyDir, 'private-data', 'AppData');
const materialDir = path.join(appData, 'materials');
mkdirSync(materialDir, { recursive: true });

let application;
let cleanupPromise;

function removeFixture() {
  if (!existsSync(fixtureRoot)) return;
  const resolved = realpathSync(fixtureRoot);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(PREFIX) ||
      lstatSync(fixtureRoot).isSymbolicLink() || readFileSync(markerFile, 'utf8') !== markerValue) {
    throw new Error(`Refusing to remove an unverified fixture directory: ${fixtureRoot}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    if (application) await application.close();
    removeFixture();
  })();
  return cleanupPromise;
}

function material(id, role, description) {
  const label = `FICTIONAL TEST ONLY - ${id}`.replace(/[\\()]/g, '');
  const stream = `BT /F1 16 Tf 40 750 Td (${label}) Tj 0 -30 Td (Not a real invoice, payment, or claim.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const contents = Buffer.from(pdf);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const storedFilename = `${sha256}.pdf`;
  writeFileSync(path.join(materialDir, storedFilename), contents, { flag: 'wx' });
  return { id, role, filename: `虚构验收-${id}.pdf`, storedFilename, sha256, verified: true };
}

function record(id, number, description) {
  const month = String(number).padStart(2, '0');
  return {
    id, accountID: 'fictional-demo-account', amount: '1.00', currency: 'USD',
    plan: description, date: `2026-${month}-01`, billingMonth: `2026-${month}`,
    invoiceNumber: `FICTIONAL-TEST-ONLY-${number}`,
    materials: [
      material(`${id}-invoice`, 'invoice', `${description}: fictional invoice, USD 1.00; no real vendor or customer.`),
      material(`${id}-payment`, 'payment', `${description}: fictional payment evidence, USD 1.00; no real card or payment.`),
    ],
  };
}

try {
  const approval = material('fictional-arp-approval', 'approval', 'Fictional approval DEMO-ARP-NOT-A-REAL-CLAIM for CNY 100.00. Only for UI acceptance testing.');
  const raw = {
    accounts: [{ id: 'fictional-demo-account', name: '虚构验收账户', vendor: 'chatgpt' }],
    records: [
      record('demo-materials', 1, '虚构 A：材料齐全，待核验付款'),
      record('demo-payment', 2, '虚构 B：已核验付款，待申报'),
      record('demo-claim', 3, '虚构 C：申报已确认，待提交'),
    ],
    inbox: [approval],
    reconciliation: {
      arpPayments: [{
        id: 'demo-arp-approved', reimbursementNumber: 'DEMO-ARP-NOT-A-REAL-CLAIM',
        summary: '虚构验收审批，仅用于界面功能测试', rawStatus: '审批通过',
        claimedAmountCNY: '100.00', approvedAmountCNY: '100.00', approvalVerified: true,
        sourceReference: `material:${approval.sha256}`, approvalSourceReference: `material:${approval.sha256}`,
      }],
    },
  };
  writeFileSync(path.join(appData, 'workspace.json'), JSON.stringify(raw, null, 2), { flag: 'wx' });
  application = await createApp({ legacyDir, dataDir, dev: false });
  const commonReview = {
    paymentVerified: true, claimConfirmed: false, claimedCNY: '',
    submissionReference: '', submittedOn: '', note: '纯合成验收记录，不代表任何真实支付或报销。',
  };
  application.store.reviewRecord('demo-payment', commonReview);
  application.store.reviewRecord('demo-claim', { ...commonReview, claimedCNY: '10.00', claimConfirmed: true });

  const state = application.store.workspace();
  const expected = { 'demo-materials': [false, false, 'needs_review'], 'demo-payment': [true, false, 'needs_review'], 'demo-claim': [true, true, 'ready'] };
  for (const entry of state.records) {
    if (JSON.stringify([entry.paymentVerified, entry.claimConfirmed, entry.status]) !== JSON.stringify(expected[entry.id])) {
      throw new Error(`Synthetic fixture state is unexpected for ${entry.id}`);
    }
  }
  if (state.records.length !== 3 || !state.arpRecords[0]?.approvalVerified) throw new Error('Synthetic fixture was not initialized correctly');

  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ fixtureOnly: true, records: state.records.map(({ id, status, paymentVerified, claimConfirmed }) => ({ id, status, paymentVerified, claimConfirmed })), arpID: state.arpRecords[0].id, approvalVerified: true }, null, 2));
    await cleanup();
  } else {
    const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (!existsSync(path.join(appDir, 'dist', 'index.html'))) throw new Error('Run pnpm build before starting this demo.');
    await new Promise((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(PORT, '127.0.0.1', resolve);
    });
    console.log(`FICTIONAL ACCEPTANCE DEMO ONLY: http://127.0.0.1:${PORT}`);
    console.log(`Temporary synthetic data: ${fixtureRoot}`);
    console.log('Record IDs: demo-materials, demo-payment, demo-claim; ARP ID: demo-arp-approved');
    console.log('Use CNY 10.00 for the confirmed claim. All names, materials and amounts are fictional.');
    console.log('Press Ctrl+C to stop and remove this verified temporary fixture directory.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      try { await cleanup(); process.exit(0); }
      catch (error) { console.error(error); process.exit(1); }
    });
  }
} catch (error) {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
}
