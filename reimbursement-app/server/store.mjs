import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { createAgentSupport } from './agent.mjs';
import { imageFormat } from './exchange-rate.mjs';

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const text = (value) => typeof value === 'string' ? value.trim() : '';

// All stored monetary quantities are exact integer cents. Never multiply floats.
export function parseMoney(value, { optional = false, signed = false, positive = false } = {}) {
  if (typeof value !== 'string') fail('金额必须使用十进制字符串。');
  const input = value.trim();
  if (!input && optional) return null;
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(input)) {
    fail('金额格式无效：请使用最多两位小数，不使用千位分隔符或科学计数法。');
  }
  const negative = input.startsWith('-');
  const [whole, fraction = ''] = input.replace(/^-/, '').split('.');
  let cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (negative) cents = -cents;
  if (cents > MAX_CENTS || cents < -MAX_CENTS) fail('金额超出支持范围。');
  if (positive && cents <= 0n) fail('金额必须大于零。');
  return Number(cents);
}

export function formatMoney(cents) {
  if (cents == null) return '';
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function sumCents(values) {
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (result > MAX_CENTS || result < -MAX_CENTS) fail('合计金额超出支持范围。', 409);
  return Number(result);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}

function cardDate(value) {
  let result = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(result);
  if (us) result = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  if (!validDate(result)) fail(`Apple Card 日期无效：${value}`);
  return result;
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop();
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readTrustedFile(root, filename) {
  if (!filename || basename(filename) !== filename || filename.includes('\0')) return null;
  const target = path.resolve(root, filename);
  try {
    if (!inside(root, target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) return null;
    if (!inside(realpathSync(root), realpathSync(target))) return null;
    return { target, bytes: readFileSync(target) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}

export function createStore({ dataDir, legacyDir }) {
  const root = path.resolve(dataDir);
  const originals = path.join(root, 'materials');
  const imports = path.join(root, 'imports');
  for (const directory of [root, originals, imports]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(root, 'reimbursement.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, raw TEXT NOT NULL, claim_cents INTEGER,
      payment_verified INTEGER NOT NULL DEFAULT 0, claim_confirmed INTEGER NOT NULL DEFAULT 0,
      submission_reference TEXT NOT NULL DEFAULT '', submitted_on TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, role TEXT NOT NULL,
      sha256 TEXT NOT NULL, stored_filename TEXT NOT NULL, legacy_verified INTEGER NOT NULL,
      raw TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_materials (
      record_id TEXT NOT NULL REFERENCES records(id), material_id TEXT NOT NULL REFERENCES materials(id),
      PRIMARY KEY(record_id, material_id)
    );
    CREATE TABLE IF NOT EXISTS arp_records (id TEXT PRIMARY KEY, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS allocations (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
      arp_id TEXT NOT NULL REFERENCES arp_records(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      basis TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allocation_materials (
      allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES materials(id),
      PRIMARY KEY(allocation_id, material_id)
    );
    CREATE TABLE IF NOT EXISTS card_sources (
      hash TEXT PRIMARY KEY, filename TEXT NOT NULL, imported_at TEXT NOT NULL,
      row_count INTEGER NOT NULL, relevant_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_transactions (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL, source_hash TEXT NOT NULL REFERENCES card_sources(hash), raw TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
  `);

  let transactionDepth = 0;
  let agentSupport;
  function transaction(work) {
    if (transactionDepth > 0) return work();
    db.exec('BEGIN IMMEDIATE');
    transactionDepth++;
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { transactionDepth--; }
  }

  function event(type, summary, details = {}) {
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(randomUUID(), now(), type, summary, JSON.stringify(details));
  }

  function importLegacy() {
    if (db.prepare("SELECT value FROM metadata WHERE key = 'legacy_import'").get()) return;
    if (!legacyDir) {
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('legacy_import', JSON.stringify({ accounts: 0, records: 0, deferredRecords: 0, materials: 0, importedAt: now() }));
      return;
    }
    const appData = path.join(path.resolve(legacyDir), 'private-data', 'AppData');
    const materialRoot = path.join(appData, 'materials');
    const rawBytes = readFileSync(path.join(appData, 'workspace.json'));
    const sourceHash = hash(rawBytes);
    const raw = JSON.parse(rawBytes.toString('utf8'));
    if (!Array.isArray(raw.accounts) || !Array.isArray(raw.records)) fail('旧账本格式无法识别。');
    const accountByID = new Map(raw.accounts.map((account) => [account.id, account]));
    const records = raw.records.filter((record) => accountByID.get(record.accountID)?.vendor === 'chatgpt');
    const materialList = [...raw.records.flatMap((record) => record.materials || []), ...(raw.inbox || [])];
    // Keep every supplied original in the new private data directory. Destinations are hashes only.
    const contentNames = new Map();
    if (existsSync(materialRoot)) {
      for (const name of readdirSync(materialRoot)) {
        const source = readTrustedFile(materialRoot, name);
        if (!source) continue;
        const digest = hash(source.bytes);
        const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(name)) ? path.extname(name).toLowerCase() : '';
        const stored = `${digest}${extension}`;
        const destination = path.join(originals, stored);
        if (!existsSync(destination)) copyFileSync(source.target, destination);
        if (hash(readFileSync(destination)) !== digest) fail(`材料复制校验失败：${name}`, 409);
        contentNames.set(name, { stored, digest });
      }
    }
    const snapshotName = `legacy-${sourceHash}.json`;
    const snapshotPath = path.join(imports, snapshotName);
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, rawBytes, { flag: 'wx', mode: 0o600 });
    if (hash(readFileSync(snapshotPath)) !== sourceHash) fail('旧账本快照校验失败。', 409);
    transaction(() => {
      const insertAccount = db.prepare('INSERT INTO accounts VALUES (?, ?)');
      for (const account of raw.accounts) insertAccount.run(account.id, JSON.stringify(account));
      const insertMaterial = db.prepare('INSERT OR IGNORE INTO materials VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const material of materialList) {
        if (!material.id || !/^[a-f0-9]{64}$/i.test(material.sha256 || '')) fail('旧材料缺少有效 ID 或 SHA-256。');
        const original = contentNames.get(material.storedFilename);
        // If the imported bytes differ from the legacy hash, keep them for inspection but never certify them.
        const stored = original?.stored || `${material.sha256.toLowerCase()}${path.extname(basename(material.storedFilename))}`;
        insertMaterial.run(material.id, basename(material.filename), material.role || 'other', material.sha256.toLowerCase(), stored, material.verified === true ? 1 : 0, JSON.stringify(material));
      }
      const insertRecord = db.prepare('INSERT INTO records(id, raw) VALUES (?, ?)');
      const linkMaterial = db.prepare('INSERT INTO record_materials VALUES (?, ?)');
      for (const record of records) {
        parseMoney(record.amount);
        insertRecord.run(record.id, JSON.stringify(record));
        for (const material of record.materials || []) linkMaterial.run(record.id, material.id);
      }
      const insertARP = db.prepare('INSERT INTO arp_records VALUES (?, ?)');
      for (const record of raw.reconciliation?.arpPayments || []) {
        if (record.claimedAmountCNY) parseMoney(record.claimedAmountCNY);
        if (record.approvedAmountCNY) parseMoney(record.approvedAmountCNY);
        insertARP.run(record.id, JSON.stringify(record));
      }
      const summary = {
        accounts: raw.accounts.length, records: records.length,
        deferredRecords: raw.records.length - records.length,
        materials: new Set(materialList.map((material) => material.sha256)).size,
        importedAt: now(), sourceHash, snapshotName,
      };
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('legacy_import', JSON.stringify(summary));
      event('legacy_import', `导入 ${records.length} 笔 ChatGPT 记录；${summary.deferredRecords} 笔 Claude 记录保留在原始快照中。`, summary);
    });
  }

  try { importLegacy(); } catch (error) { db.close(); throw error; }

  function allMaterials() {
    const fileChecks = new Map();
    return db.prepare('SELECT * FROM materials').all().map((row) => {
      const cacheKey = `${row.stored_filename}:${row.sha256}`;
      if (!fileChecks.has(cacheKey)) {
        const file = readTrustedFile(originals, row.stored_filename);
        fileChecks.set(cacheKey, { integrity: !file ? 'missing' : hash(file.bytes) === row.sha256 ? 'ok' : 'changed', imageFormat: file ? imageFormat(file.bytes) : null });
      }
      return {
        id: row.id, filename: row.filename, role: row.role, sha256: row.sha256,
        legacyVerified: !!row.legacy_verified, integrity: fileChecks.get(cacheKey).integrity,
        ...(row.role === 'exchangeRate' ? { imageFormat: fileChecks.get(cacheKey).imageFormat } : {}),
        href: `/api/materials/${encodeURIComponent(row.id)}`,
        source: JSON.parse(row.raw).source || null,
      };
    });
  }

  function allocationRows() {
    const links = db.prepare('SELECT * FROM allocation_materials ORDER BY material_id').all();
    return db.prepare('SELECT * FROM allocations ORDER BY created_at, id').all().map(row => ({ ...row, evidenceIDs: links.filter(link => link.allocation_id === row.id).map(link => link.material_id) }));
  }
  const allocationView = (row) => ({ id: row.id, recordID: row.record_id, arpID: row.arp_id, amountCNY: formatMoney(row.amount_cents), basis: row.basis, evidenceIDs: row.evidenceIDs || [] });

  function arpViews(materials, allocations) {
    return db.prepare('SELECT * FROM arp_records ORDER BY id DESC').all().map((row) => {
      const raw = JSON.parse(row.raw);
      const references = [...new Set([raw.sourceReference, raw.approvalSourceReference, ...(raw.evidenceIDs || []).map(id => `material:${id}`)].filter(Boolean))];
      const matches = references.map((ref) => materials.find((material) => ref === `material:${material.sha256}` || ref === `material:${material.id}`));
      const approvalMaterial = materials.find((material) => raw.approvalSourceReference === `material:${material.sha256}` || raw.approvalSourceReference === `material:${material.id}`);
      const observationMaterial = materials.find((material) => raw.sourceReference === `material:${material.sha256}` || raw.sourceReference === `material:${material.id}`);
      // An explicit financial-review stage proves handoff, but never proves final approval.
      // Do not match a generic/departmental review, a historical approval phrase, or a rejection.
      const financialReviewStatus = /^(?:当前(?:环节|状态)[：:]\s*)?财务(?:审核|审批)(?:中|进行中)?$/.test(text(raw.rawStatus));
      const observationVerified = !!observationMaterial && matches.length > 0 && matches.every(material => material?.integrity === 'ok') &&
        typeof raw.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.observedAt) && Number.isFinite(Date.parse(raw.observedAt));
      const supportedStatus = /生成凭证|审批通过|审核通过|已批准|已完成|已报销|^approved$|^completed$/i.test(raw.rawStatus || '');
      const approvalVerified = raw.approvalVerified === true && !raw.hasUnresolvedAdjustment && supportedStatus &&
        !!approvalMaterial && matches.length > 0 && matches.every((material) => material?.integrity === 'ok') && parseMoney(raw.approvedAmountCNY || '0') > 0;
      const approved = parseMoney(raw.approvedAmountCNY || '', { optional: true });
      const reserved = parseMoney(raw.reservedCNY || '0');
      const used = sumCents(allocations.filter((allocation) => allocation.arp_id === row.id).map((allocation) => allocation.amount_cents));
      return {
        id: row.id, reimbursementNumber: raw.reimbursementNumber || '', summary: raw.summary || '',
        status: raw.rawStatus || '未知', claimedCNY: raw.claimedAmountCNY ? formatMoney(parseMoney(raw.claimedAmountCNY)) : '',
        approvedCNY: formatMoney(approved), approvalVerified,
        financeReviewPending: !approvalVerified && !raw.hasUnresolvedAdjustment && financialReviewStatus && observationVerified,
        observationVerified, observedAt: raw.observedAt || null,
        reservedCNY: formatMoney(reserved), reserveReason: raw.reserveReason || '',
        availableCNY: approvalVerified ? formatMoney(Math.max(0, approved - reserved - used)) : '',
        sourceLabel: raw.sourceLabel || '历史材料，截至 2026-09-06；尚未在线刷新，核实全部审批通过后按用户规则默认到账',
        materialIds: [...new Set(matches.filter(Boolean).map((material) => material.id))],
      };
    });
  }

  function workspace() {
    const materials = allMaterials();
    const materialByID = new Map(materials.map((material) => [material.id, material]));
    const allocations = allocationRows();
    const arps = arpViews(materials, allocations);
    const arpByID = new Map(arps.map((record) => [record.id, record]));
    const allocationEvidenceOK = allocation => allocation.evidenceIDs.every(id => materialByID.get(id)?.integrity === 'ok');
    const accounts = new Map(db.prepare('SELECT * FROM accounts').all().map((row) => [row.id, JSON.parse(row.raw)]));
    const links = db.prepare('SELECT * FROM record_materials').all();
    const records = db.prepare('SELECT * FROM records').all().map((row) => {
      const raw = JSON.parse(row.raw);
      const account = accounts.get(raw.accountID);
      const attached = links.filter((link) => link.record_id === row.id).map((link) => materialByID.get(link.material_id));
      const recordAllocations = allocations.filter((allocation) => allocation.record_id === row.id);
      const allAllocated = sumCents(recordAllocations.map((allocation) => allocation.amount_cents));
      const verifiedAllocated = sumCents(recordAllocations.filter((allocation) => arpByID.get(allocation.arp_id)?.approvalVerified && allocationEvidenceOK(allocation)).map((allocation) => allocation.amount_cents));
      const invoiceOK = attached.some((material) => material.role === 'invoice' && material.integrity === 'ok');
      const paymentOK = attached.some((material) => material.role === 'payment' && material.integrity === 'ok');
      const issues = [];
      if (!invoiceOK) issues.push('缺少完整的发票原件');
      if (!paymentOK) issues.push('缺少完整的付款凭证');
      if (attached.some((material) => material.integrity !== 'ok')) issues.push('关联材料缺失或内容发生变化，需重新核验');
      if (!row.payment_verified) issues.push('付款事实尚未核实');
      if (!row.claim_confirmed || !row.claim_cents) issues.push('人民币申报金额与申报口径尚未确认');
      if (recordAllocations.some((allocation) => !arpByID.get(allocation.arp_id)?.approvalVerified)) issues.push('关联 ARP 审批依据已失效或尚未核实');
      if (recordAllocations.some(allocation => !allocationEvidenceOK(allocation))) issues.push('账单与审批的对应证据已缺失或变化，关联金额不再计入完成进度');
      if (row.claim_cents != null && allAllocated > row.claim_cents) issues.push('分摊金额超过申报金额');
      if (recordAllocations.some((allocation) => {
        const arp = arpByID.get(allocation.arp_id);
        const total = sumCents(allocations.filter((item) => item.arp_id === allocation.arp_id).map((item) => item.amount_cents));
        return arp?.approvedCNY && BigInt(total) + BigInt(parseMoney(arp.reservedCNY)) > BigInt(parseMoney(arp.approvedCNY));
      })) issues.push('ARP 来源存在超额分摊');
      let status = 'needs_review';
      if (row.claim_confirmed && row.claim_cents > 0 && verifiedAllocated >= row.claim_cents) status = 'completed';
      else if (issues.length === 0) {
        if (verifiedAllocated > 0) status = 'partial';
        else if (row.submission_reference || row.submitted_on) status = 'submitted';
        else status = 'ready';
      }
      const reviewSource = status !== 'completed' && row.submission_reference
        ? arps.find(arp => arp.reimbursementNumber === row.submission_reference && arp.financeReviewPending)
        : null;
      const financeReviewPending = !!reviewSource;
      if (financeReviewPending) status = 'submitted';
      return {
        id: row.id, accountID: raw.accountID, accountName: account?.name || raw.accountID,
        vendor: account?.vendor || '', plan: raw.plan || '', date: raw.date || '', billingMonth: raw.billingMonth || '',
        invoiceNumber: raw.invoiceNumber || '', amount: formatMoney(parseMoney(raw.amount)), currency: raw.currency || '',
        claimedCNY: formatMoney(row.claim_cents), paymentVerified: !!row.payment_verified && invoiceOK && paymentOK,
        claimConfirmed: !!row.claim_confirmed, submissionReference: row.submission_reference, submittedOn: row.submitted_on,
        notes: [raw.notes, row.review_note].filter(Boolean).join('\n\n最近核对：'),
        exchangeRate: raw.exchangeRate || null,
        materials: attached, approvedCNY: formatMoney(verifiedAllocated),
        outstandingCNY: row.claim_confirmed && row.claim_cents != null ? formatMoney(Math.max(0, row.claim_cents - verifiedAllocated)) : null,
        status, issues,
        financeReviewPending, priorStepsComplete: status === 'completed' || financeReviewPending,
        financeReviewARPId: reviewSource?.id || null, financeReviewEvidenceIDs: reviewSource?.materialIds || [],
      };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const gaps = [];
    const current = new Date();
    const currentMonth = current.getFullYear() * 12 + current.getMonth();
    const recordedMonths = new Set(records.map((record) => record.billingMonth));
    for (let index = 2026 * 12; index <= currentMonth; index++) {
      const month = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      if (!recordedMonths.has(month)) gaps.push({ month, reason: '未核查：现有材料没有该月记录，不能据此推定未付款或缺发票。' });
    }
    const cardTransactions = db.prepare(`SELECT t.*, s.filename AS source_filename FROM card_transactions t
      JOIN card_sources s ON s.hash = t.source_hash ORDER BY t.date DESC, t.id`).all().map((row) => {
      const candidates = row.kind === 'purchase' && row.amount_cents > 0 ? records.filter((record) => {
        const days = Math.abs(Date.parse(`${record.date}T00:00:00Z`) - Date.parse(`${row.date}T00:00:00Z`)) / 86400000;
        return record.currency === 'USD' && parseMoney(record.amount) === row.amount_cents && days <= 3;
      }).map((record) => record.id) : [];
      return {
        id: row.id, date: row.date, description: row.description, amount: formatMoney(row.amount_cents), currency: 'USD',
        sourceFilename: row.source_filename, candidateRecordIDs: candidates, kind: row.kind,
      };
    });
    const savedSummary = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'legacy_import'").get().value);
    const state = {
      scope: 'ChatGPT / Codex 第一阶段；有完整 ARP 查询依据且明确对应的财务审核中记录，前四步自动完成；全部审批通过且足额覆盖已确认申报后全部完成并默认到账，无独立银行核验；原始材料与人工核验记录保留',
      records, arpRecords: arps, allocations: allocations.map(allocationView), cardTransactions, gaps,
      events: db.prepare('SELECT id, at, type, summary FROM events ORDER BY rowid DESC LIMIT 200').all(),
      importSummary: { accounts: savedSummary.accounts, records: savedSummary.records, deferredRecords: savedSummary.deferredRecords, materials: savedSummary.materials, importedAt: savedSummary.importedAt },
      sources: [
        { id: 'chatgpt', name: 'ChatGPT / Codex 账单', url: 'https://chatgpt.com', status: '等待 Agent 采集', detail: 'Codex 使用浏览器收集材料，再通过 MCP/API 导入；软件不接管网页登录。' },
        { id: 'apple', name: 'Apple Card 付款记录', url: 'https://card.apple.com', status: '可导入 CSV', detail: '可导入 Wallet 导出的 Apple Card CSV；候选匹配仅供复核，退款与贷项单列，不自动确认付款。' },
        { id: 'arp', name: 'IHEP ARP', url: 'https://ihep.arp.cn', status: '需手动登录', detail: '已保留截至 2026-09-06 的历史查询和审批材料；当前页面尚未同步。核实该笔全部审批通过且足额覆盖申报后，前序流程自动完成并按用户规则默认到账，不单独核查银行到账。' },
      ],
    };
    return agentSupport ? agentSupport.decorate(state) : state;
  }

  function recordRow(id) {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    if (!row) fail('找不到第一阶段范围内的记录。', 404);
    return row;
  }

  function reviewRecord(id, payload, actor = { type: 'human', id: 'local-ui' }) {
    if (!payload || typeof payload !== 'object') fail('复核内容无效。');
    const note = text(payload.note);
    if (!note) fail('请填写复核说明。');
    if (typeof payload.paymentVerified !== 'boolean' || typeof payload.claimConfirmed !== 'boolean') fail('付款和申报确认必须为布尔值。');
    const claimed = parseMoney(payload.claimedCNY, { optional: !payload.claimConfirmed, positive: payload.claimConfirmed });
    const submissionReference = text(payload.submissionReference);
    const submittedOn = text(payload.submittedOn);
    if (submittedOn && !validDate(submittedOn)) fail('提交日期必须是有效的 YYYY-MM-DD 日期。');
    transaction(() => {
      const previous = recordRow(id);
      if (payload.baseVersion) agentSupport?.expectVersion('record', id, payload.baseVersion);
      const view = workspace().records.find((record) => record.id === id);
      if (payload.paymentVerified && (!view.materials.some((material) => material.role === 'invoice' && material.integrity === 'ok') || !view.materials.some((material) => material.role === 'payment' && material.integrity === 'ok'))) {
        fail('确认付款需要内容完整的发票和付款凭证。', 409);
      }
      const allocated = sumCents(allocationRows().filter((allocation) => allocation.record_id === id).map((allocation) => allocation.amount_cents));
      if (allocated > 0 && (claimed == null || claimed < allocated)) fail('申报金额不能低于已有分摊；请先移除相应分摊。', 409);
      db.prepare(`UPDATE records SET claim_cents = ?, payment_verified = ?, claim_confirmed = ?,
        submission_reference = ?, submitted_on = ?, review_note = ? WHERE id = ?`).run(claimed, +payload.paymentVerified, +payload.claimConfirmed, submissionReference, submittedOn, note, id);
      agentSupport?.touch('record', id, actor, note);
      event('record_review', `${actor.type === 'agent' ? 'Agent 核对' : '人工维护'} ${JSON.parse(previous.raw).invoiceNumber}：${note}`, {
        actor,
        recordID: id, before: { claimCents: previous.claim_cents, paymentVerified: !!previous.payment_verified, claimConfirmed: !!previous.claim_confirmed, submissionReference: previous.submission_reference, submittedOn: previous.submitted_on },
        after: { claimCents: claimed, paymentVerified: payload.paymentVerified, claimConfirmed: payload.claimConfirmed, submissionReference, submittedOn, note },
      });
    });
    return workspace().records.find((record) => record.id === id);
  }

  function allocate(payload, actor = { type: 'human', id: 'local-ui' }) {
    if (!payload || typeof payload !== 'object') fail('分摊内容无效。');
    const amount = parseMoney(payload.amountCNY, { positive: true });
    const basis = text(payload.basis);
    if (!basis) fail('请填写具体的分摊依据。');
    const id = randomUUID();
    transaction(() => {
      const record = recordRow(payload.recordID);
      const state = workspace();
      const arp = state.arpRecords.find((item) => item.id === payload.arpID);
      if (!arp) fail('找不到 ARP 记录。', 404);
      if (!arp.approvalVerified) fail('ARP 审批尚未核实或原件不完整，不能分摊。', 409);
      if (!record.claim_confirmed || !record.claim_cents) fail('请先确认人民币申报金额和申报口径。', 409);
      const previous = sumCents(allocationRows().filter((allocation) => allocation.record_id === payload.recordID).map((allocation) => allocation.amount_cents));
      if (BigInt(previous) + BigInt(amount) > BigInt(record.claim_cents)) fail('分摊金额超过该记录的已确认申报金额。', 409);
      if (amount > parseMoney(arp.availableCNY)) fail('分摊金额超过该 ARP 记录的可用审批金额。', 409);
      const evidenceIDs = payload.evidenceIDs || [];
      if (!Array.isArray(evidenceIDs) || evidenceIDs.some(id => typeof id !== 'string')) fail('审批对应证据列表无效。');
      const materials = new Map(allMaterials().map(material => [material.id, material]));
      if (evidenceIDs.some(id => materials.get(id)?.integrity !== 'ok')) fail('审批对应证据缺失或内容发生变化。', 409);
      db.prepare('INSERT INTO allocations VALUES (?, ?, ?, ?, ?, ?)').run(id, payload.recordID, payload.arpID, amount, basis, now());
      for (const materialID of new Set(evidenceIDs)) db.prepare('INSERT INTO allocation_materials VALUES (?,?)').run(id, materialID);
      agentSupport?.touch('allocation', id, actor, basis);
      agentSupport?.touch('record', payload.recordID, actor, '关联审批分摊');
      event('allocation_created', `${JSON.parse(record.raw).invoiceNumber} 关联 ${arp.reimbursementNumber}：¥${formatMoney(amount)}`, { id, ...payload });
    });
    return { id, recordID: payload.recordID, arpID: payload.arpID, amountCNY: formatMoney(amount), basis, evidenceIDs: [...new Set(payload.evidenceIDs || [])] };
  }

  function removeAllocation(id, actor = { type: 'human', id: 'local-ui' }) {
    transaction(() => {
      const previous = db.prepare('SELECT * FROM allocations WHERE id = ?').get(id);
      if (!previous) fail('找不到分摊记录。', 404);
      db.prepare('DELETE FROM allocations WHERE id = ?').run(id);
      agentSupport?.touch('allocation', id, actor, '移除审批分摊');
      agentSupport?.touch('record', previous.record_id, actor, '移除审批分摊');
      event('allocation_removed', `移除金额 ¥${formatMoney(previous.amount_cents)} 的分摊关联。`, previous);
    });
    return { removed: true, id };
  }

  function importAppleCard(payload) {
    if (!payload || typeof payload.csv !== 'string' || !text(payload.filename)) fail('请提供文件名和 CSV 文本。');
    if (Buffer.byteLength(payload.csv, 'utf8') > MAX_CSV_BYTES) fail('CSV 文件不能超过 10 MB。');
    const filename = basename(text(payload.filename));
    if (!filename || filename.includes('\0')) fail('文件名无效。');
    const sourceHash = hash(payload.csv);
    const existing = db.prepare('SELECT * FROM card_sources WHERE hash = ?').get(sourceHash);
    if (existing) {
      const preserved = readTrustedFile(imports, `apple-card-${sourceHash}.csv`);
      if (!preserved || hash(preserved.bytes) !== sourceHash) fail('已导入 CSV 原件缺失或已改变，无法确认重复导入。', 409);
      return { imported: 0, duplicates: existing.relevant_count, ignored: existing.row_count - existing.relevant_count, sourceHash, alreadyImported: true };
    }
    let rows;
    const required = ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'];
    try {
      rows = parse(payload.csv, { bom: true, skip_empty_lines: true, trim: true, max_record_size: MAX_CSV_BYTES,
        columns(headers) {
          if (headers.length !== new Set(headers).size || !required.every((key) => headers.includes(key))) fail('无法识别 Apple Card CSV 表头；请导入包含交易日期、类型及美元金额的标准导出。');
          return headers;
        },
      });
    } catch (error) { if (error.statusCode) throw error; fail(`CSV 格式无效：${error.message}`); }
    if (!rows.length) fail('CSV 没有交易记录。');
    const occurrences = new Map();
    const prepared = [];
    // Validate every row before making any database or file change.
    for (const [index, row] of rows.entries()) {
      let cents;
      try { cents = parseMoney(row['Amount (USD)'], { signed: true }); }
      catch { fail(`CSV 第 ${index + 2} 行金额无效。`); }
      const date = cardDate(row['Transaction Date']);
      if (row['Clearing Date']) cardDate(row['Clearing Date']);
      if (!text(row.Type)) fail(`CSV 第 ${index + 2} 行缺少交易类型。`);
      const relevant = /openai|chatgpt|codex/i.test(`${row.Description} ${row.Merchant}`);
      const credit = cents < 0 || /credit|refund|return|payment|reversal/i.test(row.Type);
      const kind = credit ? 'credit' : /^purchase$/i.test(row.Type) ? 'purchase' : 'other';
      if (credit && cents > 0) cents = -cents;
      const identity = hash(JSON.stringify(required.map((key) => key === 'Transaction Date' ? date : key === 'Amount (USD)' ? formatMoney(cents) : key === 'Clearing Date' && row[key] ? cardDate(row[key]) : text(row[key]))));
      const ordinal = (occurrences.get(identity) || 0) + 1;
      occurrences.set(identity, ordinal);
      if (relevant) prepared.push({ id: `apple:${identity}:${ordinal}`, date, cents, kind, raw: row,
        description: `${credit ? '退款/贷项 · ' : kind === 'other' ? '待核对交易 · ' : ''}${row.Description || row.Merchant}` });
    }
    const rawPath = path.join(imports, `apple-card-${sourceHash}.csv`);
    if (!existsSync(rawPath)) writeFileSync(rawPath, payload.csv, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
    if (hash(readFileSync(rawPath)) !== sourceHash) fail('CSV 原件校验失败。', 409);
    let imported = 0;
    transaction(() => {
      db.prepare('INSERT INTO card_sources VALUES (?, ?, ?, ?, ?)').run(sourceHash, filename, now(), rows.length, prepared.length);
      const insert = db.prepare('INSERT OR IGNORE INTO card_transactions VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of prepared) imported += Number(insert.run(row.id, row.date, row.description, row.cents, row.kind, sourceHash, JSON.stringify(row.raw)).changes);
      event('apple_card_import', `导入 ${filename}：新增 ${imported} 笔相关交易，重复 ${prepared.length - imported} 笔；付款仍待人工复核。`, { sourceHash, filename, imported, duplicates: prepared.length - imported, ignored: rows.length - prepared.length });
    });
    return { imported, duplicates: prepared.length - imported, ignored: rows.length - prepared.length, sourceHash, alreadyImported: false };
  }

  function material(id) {
    const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
    if (!row) fail('材料不存在。', 404);
    const file = readTrustedFile(originals, row.stored_filename);
    if (!file) fail('材料原件缺失。', 409);
    if (hash(file.bytes) !== row.sha256) fail('材料内容与登记哈希不符，已阻止下载。', 409);
    const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[path.extname(row.filename).toLowerCase()] || 'application/octet-stream';
    return { path: file.target, filename: row.filename, mime };
  }

  agentSupport = createAgentSupport({ db, transaction, event, originals, workspace, recordRow, allMaterials, material, reviewRecord, allocate, removeAllocation, parseMoney, formatMoney });
  return { workspace, reviewRecord, allocate, removeAllocation, importAppleCard, material,
    executeAgentCommand: agentSupport.execute, verifyRecord: agentSupport.verifyRecord,
    setDelivery: agentSupport.setDelivery, importRecordMaterial: agentSupport.importRecordMaterial,
    uploadPolicy: agentSupport.uploadPolicy, updatePolicy: agentSupport.updatePolicy,
    agentTasks: agentSupport.tasks, history: agentSupport.history, close: () => db.close() };
}
