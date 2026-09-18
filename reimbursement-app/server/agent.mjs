import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { exchangeRateView } from './exchange-rate.mjs';

const str = { type: 'string', minLength: 1 };
const money = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' };
const ids = { type: 'array', items: str, uniqueItems: true };
const evidence = { ...ids, minItems: 1 };
const source = { type: 'object', additionalProperties: false, properties: { kind: { enum: ['user-upload', 'browser-download', 'browser-observation', 'generated'] }, url: { type: 'string' }, capturedAt: { type: 'string' }, note: { type: 'string' } }, required: ['kind'] };
function object(properties = {}, required = []) { return { type: 'object', additionalProperties: false, properties, required }; }
const policyFields = { id: str, title: str, versionLabel: str, materialID: str, status: { enum: ['active', 'reference', 'superseded'] }, note: { type: 'string' }, clauses: { type: 'array', maxItems: 500, items: object({ id: str, topic: str, section: str, pdfPage: { type: 'integer', minimum: 1 }, printedPage: { type: 'string' }, quote: str, interpretation: str, scope: str }, ['id', 'topic', 'section', 'pdfPage', 'quote', 'interpretation', 'scope']) } };
function command(name, description, properties = {}, required = [], { readOnly = false, version = false } = {}) {
  return { name, description, readOnly, inputSchema: object({ ...(readOnly ? {} : { operationId: str, baseVersion: str }), payload: object(properties, required) }, readOnly ? [] : ['operationId', 'payload', ...(version ? ['baseVersion'] : [])]) };
}
const catalog = [
  command('workspace.get', 'Read the local reimbursement ledger, source evidence, versions, documents and verification states.', {}, [], { readOnly: true }),
  command('tasks.list', 'List missing evidence, incomplete workflow steps, human verification and month coverage gaps. Evidence-backed ARP financial review with an exact submission reference completes the first four steps, leaving only financial approval. Verified full approval completes all steps and assumes reimbursement arrival without bank/cash checks or changing original facts.', {}, [], { readOnly: true }),
  command('history.list', 'Read immutable version history. This is an export foundation; remote merge is not enabled.', { entityType: { enum: ['record', 'arp', 'material', 'allocation', 'document', 'source', 'delivery', 'policy'] }, entityID: str, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, [], { readOnly: true }),
  command('material.import', 'Preserve an original PDF/image/DOCX/CSV/XLSX/JSON with its SHA-256; optionally attach it to a record. baseVersion is required when attaching. Use statement only for an explicitly identified situation/explanation statement, not for a generic review report. exchangeRate identifies an original BOC webpage screenshot with browser provenance; tables/JSON/documents cannot substitute for it. policy requires a non-generated original PDF and is registered separately as a rule source.', { filename: str, role: { enum: ['invoice', 'payment', 'receipt', 'approval', 'observation', 'document', 'statement', 'exchangeRate', 'policy', 'other'] }, contentBase64: str, source, recordID: str }, ['filename', 'role', 'contentBase64', 'source']),
  command('policy.register', 'Register or update a rule source using an intact original policy PDF. Preserve exact quoted clauses, 1-based PDF pages, interpretation and applicability scope separately. Active is a selected authority, not automatic certification of an interpretation. Does not change existing reimbursement facts or exchange-rate selections. Use baseVersion new for a new policy.', policyFields, Object.keys(policyFields), { version: true }),
  command('invoice.upsert', 'Create or update an evidence-backed GPT invoice. Use baseVersion new for a new record, otherwise its current version. Never infer payment from an invoice.', { id: str, accountID: str, accountName: str, vendor: { const: 'chatgpt' }, invoiceNumber: str, date: str, billingMonth: str, amount: money, currency: { enum: ['USD', 'CNY', 'EUR', 'GBP', 'HKD'] }, plan: { type: 'string' }, notes: { type: 'string' }, evidenceIDs: evidence }, ['id', 'accountID', 'accountName', 'vendor', 'invoiceNumber', 'date', 'billingMonth', 'amount', 'currency', 'evidenceIDs'], { version: true }),
  command('record.patch', 'Patch only supplied payment/claim/submission fields using evidence and a reason. Agent assertions and human verification remain separate.', { recordID: str, paymentVerified: { type: 'boolean' }, claimConfirmed: { type: 'boolean' }, claimedCNY: { type: 'string' }, submissionReference: { type: 'string' }, submittedOn: { type: 'string' }, note: str, evidenceIDs: evidence }, ['recordID', 'note', 'evidenceIDs'], { version: true }),
  command('exchangeRate.set', 'Record the BOC middle conversion quote for the exact invoice date and currency, per 100 foreign units. Requires intact original image screenshots from official BOC browser sources. Computes CNY with exact half-up rounding and returns the updated record; never changes existing claimed, submitted, paid or approved amounts. A new record version makes old packages stale.', { recordID: str, date: str, currency: { enum: ['USD', 'EUR', 'GBP', 'HKD'] }, provider: { const: 'BOC' }, rateType: { const: '中行折算价' }, quotedRate: { type: 'string', pattern: '^\\d{1,7}(\\.\\d{1,6})?$' }, unit: { const: 100 }, sourceUrl: str, evidenceIDs: evidence, note: str }, ['recordID', 'date', 'currency', 'provider', 'rateType', 'quotedRate', 'unit', 'sourceUrl', 'evidenceIDs', 'note'], { version: true }),
  command('arp.upsert', 'Preserve a dated ARP observation/approval with intact source evidence. An explicit current financial-review stage plus an exact invoice submissionReference completes the first four steps; generic/departmental review does not. Verified full approval with complete allocation completes all steps and assumes reimbursement arrived, with no bank checks or fabricated history. reservedCNY reserves approved money for out-of-scope expenses, requires reserveReason, and defaults to zero for new sources; omitted reservation fields preserve existing values.', { id: str, reimbursementNumber: str, summary: { type: 'string' }, status: str, claimedCNY: money, approvedCNY: { type: 'string' }, reservedCNY: money, reserveReason: { type: 'string' }, approvalVerified: { type: 'boolean' }, evidenceIDs: evidence, approvalEvidenceID: str, sourceLabel: str, observedAt: str, hasUnresolvedAdjustment: { type: 'boolean' } }, ['id', 'reimbursementNumber', 'status', 'claimedCNY', 'approvalVerified', 'evidenceIDs', 'sourceLabel', 'observedAt'], { version: true }),
  command('allocation.create', 'Allocate approved CNY to a confirmed claim. Requires evidence of the exact invoice-to-ARP relationship, not merely equal amounts.', { recordID: str, arpID: str, amountCNY: money, basis: str, evidenceIDs: evidence }, ['recordID', 'arpID', 'amountCNY', 'basis', 'evidenceIDs'], { version: true }),
  command('allocation.remove', 'Remove an allocation while retaining its audit trail. baseVersion is the related record version.', { allocationID: str, reason: str }, ['allocationID', 'reason'], { version: true }),
  command('document.register', 'Register externally generated DOCX/PDF output and exact source versions. purpose defaults to review; application is explicit, never inferred from an old review. A ready application needs a situation-statement DOCX plus submissionPDFMaterialID identifying the combined PDF of statement, invoices, payment and invoice-date BOC screenshots. All source originals must be in sourceMaterialIDs, with verified payment and confirmed CNY equal to exact BOC conversion (CNY exempt). Otherwise use draft. No ZIP is required. The tool does not render or visually certify content.', { id: str, title: str, purpose: { enum: ['review', 'application'] }, materialIDs: evidence, submissionPDFMaterialID: str, recordIDs: ids, sourceRecordVersions: { type: 'object', additionalProperties: str }, sourceMaterialIDs: ids, status: { enum: ['draft', 'ready'] }, note: str }, ['id', 'title', 'materialIDs', 'recordIDs', 'sourceRecordVersions', 'sourceMaterialIDs', 'status', 'note'], { version: true }),
  command('delivery.set', 'Record explicit user feedback about a particular file handed to the finance secretary. This is independent of ARP submission/approval and human verification. baseVersion is the deliveryItems item version, not the invoice record version. Agent writes require a note stating the feedback or evidence.', { recordID: str, materialID: str, status: { enum: ['unknown', 'submitted', 'not_submitted'] }, note: { type: 'string' } }, ['recordID', 'materialID', 'status'], { version: true }),
  command('source.update', 'Record a browser collection attempt, evidence, coverage and any login/input blocker. Collection is performed by Codex, not this application.', { id: { enum: ['chatgpt', 'apple', 'arp'] }, status: { enum: ['needs_login', 'blocked', 'partial', 'complete'] }, detail: str, checkedAt: str, evidenceIDs: ids, coverageFrom: { type: 'string' }, coverageTo: { type: 'string' } }, ['id', 'status', 'detail', 'checkedAt', 'evidenceIDs']),
];
export function getAgentCatalog() { return structuredClone(catalog); }
export function executeAgentCommand(store, command) { return store.executeAgentCommand(command); }

const ajv = new Ajv({ allErrors: true });
const validators = new Map(catalog.map(item => [item.name, ajv.compile(item.inputSchema)]));
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const currentTime = () => new Date().toISOString();
const clean = value => typeof value === 'string' ? value.trim() : '';
const humanActor = { type: 'human', id: 'local-ui' };

export function createAgentSupport(ctx) {
  const { db, transaction, event, originals, workspace, recordRow, parseMoney, formatMoney } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_versions (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version TEXT NOT NULL, modified_at TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(entity_type, entity_id));
    CREATE TABLE IF NOT EXISTS version_history (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS version_history_no_update BEFORE UPDATE ON version_history BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS version_history_no_delete BEFORE DELETE ON version_history BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
    CREATE TABLE IF NOT EXISTS agent_operations (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS human_verifications (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, reviewed_version TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id));
    CREATE TABLE IF NOT EXISTS generated_documents (id TEXT PRIMARY KEY, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_observations (id TEXT PRIMARY KEY, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS policy_documents (id TEXT PRIMARY KEY, raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_items (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id), material_id TEXT NOT NULL REFERENCES materials(id),
      status TEXT NOT NULL CHECK(status IN ('unknown','submitted','not_submitted')),
      updated_at TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL,
      UNIQUE(record_id,material_id)
    );
  `);
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('device_id', randomUUID());
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('lamport_clock', '0');
  const deviceID = db.prepare("SELECT value FROM metadata WHERE key='device_id'").get().value;
  function version(type, id) { return db.prepare('SELECT version FROM entity_versions WHERE entity_type=? AND entity_id=?').get(type, id)?.version || '0@legacy'; }
  function expectVersion(type, id, expected, exists = true) {
    if (!expected) fail('修改必须提供 baseVersion；请先读取当前记录。', 409);
    const actual = exists ? version(type, id) : 'new';
    if (expected !== actual) fail(`版本冲突：${type}/${id} 当前版本为 ${actual}，请重新读取并核对修改。`, 409);
  }
  function snapshot(type, id) {
    const tables = { record: 'records', arp: 'arp_records', material: 'materials', allocation: 'allocations', document: 'generated_documents', source: 'source_observations', delivery: 'delivery_items', policy: 'policy_documents' };
    const row = db.prepare(`SELECT * FROM ${tables[type]} WHERE id=?`).get(id);
    if (type === 'record' && row) return { ...row, materialIDs: db.prepare('SELECT material_id FROM record_materials WHERE record_id=? ORDER BY material_id').all(id).map(item => item.material_id) };
    if (type === 'allocation' && row) return { ...row, evidenceIDs: db.prepare('SELECT material_id FROM allocation_materials WHERE allocation_id=? ORDER BY material_id').all(id).map(item => item.material_id) };
    return row || { id, deleted: true };
  }
  function touch(type, id, actor = humanActor, reason = '更新记录') {
    const clock = BigInt(db.prepare("SELECT value FROM metadata WHERE key='lamport_clock'").get().value) + 1n;
    db.prepare("UPDATE metadata SET value=? WHERE key='lamport_clock'").run(String(clock));
    const next = `${clock}@${deviceID}`;
    const at = currentTime();
    db.prepare('INSERT INTO entity_versions VALUES (?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=excluded.version,modified_at=excluded.modified_at,actor=excluded.actor').run(type, id, next, at, JSON.stringify(actor));
    db.prepare('INSERT INTO version_history(entity_type,entity_id,version,at,actor,reason,snapshot) VALUES (?,?,?,?,?,?,?)').run(type, id, next, at, JSON.stringify(actor), reason, JSON.stringify(snapshot(type, id)));
    return next;
  }
  function evidenceCheck(list) {
    if (!Array.isArray(list)) fail('证据列表无效。');
    const available = new Map(ctx.allMaterials().map(item => [item.id, item]));
    return list.map(id => {
      const item = available.get(id);
      if (!item || item.integrity !== 'ok') fail(`证据 ${id} 不存在、缺失或内容已变化。`, 409);
      return item;
    });
  }
  function attach(recordID, list) {
    let added = 0;
    for (const id of list) added += Number(db.prepare('INSERT OR IGNORE INTO record_materials VALUES (?,?)').run(recordID, id).changes);
    return added;
  }
  function fingerprint(record) { const { version: ignored, humanVerification: ignored2, lastModified: ignored3, evidenceFingerprint: ignored4, ...facts } = record; return digest(stable(facts)); }
  function completedByApproval(record) {
    const claimed = parseMoney(record.claimedCNY || '0');
    return record.status === 'completed' || (record.claimConfirmed && claimed > 0 && parseMoney(record.approvedCNY || '0') >= claimed);
  }
  function completedByFinance(record) { return completedByApproval(record) || record.financeReviewPending === true; }
  function decorate(state) {
    for (const record of state.records) {
      record.exchangeRate = exchangeRateView(record);
      const saved = db.prepare('SELECT * FROM human_verifications WHERE entity_type=? AND entity_id=?').get('record', record.id);
      const contentHash = fingerprint(record);
      const currentVersion = version('record', record.id);
      record.version = currentVersion;
      record.evidenceFingerprint = contentHash;
      const meta = db.prepare('SELECT modified_at,actor FROM entity_versions WHERE entity_type=? AND entity_id=?').get('record', record.id);
      record.lastModified = meta ? { at: meta.modified_at, actor: JSON.parse(meta.actor) } : null;
      record.humanVerification = saved ? { status: saved.reviewed_version !== currentVersion || saved.fingerprint !== contentHash ? 'stale' : saved.result === 'accepted' ? 'verified' : 'rejected', reviewedVersion: saved.reviewed_version, note: saved.note, at: saved.at } : { status: 'unreviewed', reviewedVersion: null, note: '', at: null };
    }
    for (const arp of state.arpRecords) arp.version = version('arp', arp.id);
    state.materials = ctx.allMaterials();
    state.policies = policyViews(state.materials);
    state.documents = db.prepare('SELECT * FROM generated_documents ORDER BY rowid DESC').all().map(row => {
      const raw = JSON.parse(row.raw);
      const staleRecords = raw.sourceRecords.filter(item => version('record', item.id) !== item.version).map(item => item.id);
      const files = raw.materialIDs.map(id => state.materials.find(item => item.id === id)).filter(Boolean);
      const sourceFiles = raw.sourceMaterialIDs.map(id => state.materials.find(item => item.id === id));
      const purpose = raw.purpose || 'review';
      const stale = staleRecords.length > 0 || sourceFiles.some(item => !item || item.integrity !== 'ok') || files.length !== raw.materialIDs.length || files.some(item => item.integrity !== 'ok');
      const readinessIssues = purpose === 'application' ? applicationIssues(raw, state) : [];
      if (purpose === 'application' && stale) readinessIssues.push('申请包来源记录、材料或版本已变化，需要更新。');
      const needsUpdate = purpose === 'application' && readinessIssues.length > 0;
      return { ...raw, purpose, registeredStatus: raw.status, status: needsUpdate && raw.status === 'ready' ? 'draft' : raw.status, ready: raw.status === 'ready' && !stale && !needsUpdate, needsUpdate, readinessIssues, version: version('document', row.id), stale, staleRecordIDs: staleRecords, materials: files };
    });
    const observations = new Map(db.prepare('SELECT * FROM source_observations').all().map(row => [row.id, JSON.parse(row.raw)]));
    state.sources = state.sources.map(item => observations.has(item.id) ? { ...item, ...observations.get(item.id), version: version('source', item.id) } : item);
    state.deliveryItems = deliveryViews(state);
    state.agent = { deviceID, sync: { enabled: false, mode: 'local-only', note: '版本历史可导出；双向合并尚未启用。' }, toolCount: catalog.length };
    return state;
  }
  function verifyRecord(id, payload) {
    if (!payload || !['accepted', 'rejected'].includes(payload.result) || !clean(payload.note)) fail('请提供 accepted/rejected 和核验说明。');
    if (typeof payload.evidenceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.evidenceFingerprint)) fail('请提供本次查看记录时的 evidenceFingerprint；刷新台账后重新核验。');
    return transaction(() => {
      recordRow(id);
      expectVersion('record', id, payload.baseVersion);
      const record = workspace().records.find(item => item.id === id);
      if (payload.evidenceFingerprint !== record.evidenceFingerprint) fail('证据状态已变化，本次核验未保存；请刷新并重新核对材料。', 409);
      const at = currentTime();
      db.prepare('INSERT INTO human_verifications VALUES (?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET reviewed_version=excluded.reviewed_version,fingerprint=excluded.fingerprint,result=excluded.result,note=excluded.note,at=excluded.at').run('record', id, record.version, record.evidenceFingerprint, payload.result, payload.note.trim(), at);
      event('human_verification', `人工${payload.result === 'accepted' ? '核验' : '退回'} ${record.invoiceNumber}：${payload.note.trim()}`, { recordID: id, version: record.version, actor: humanActor });
      return workspace().records.find(item => item.id === id);
    });
  }
  function deliveryKey(recordID, materialID) { return `delivery:${digest(stable([recordID, materialID]))}`; }
  function deliveryViews(state) {
    const saved = new Map(db.prepare('SELECT * FROM delivery_items').all().map(row => [row.id, row]));
    const items = [];
    for (const record of state.records) {
      const approvalCompleted = completedByApproval(record);
      const financeCompleted = completedByFinance(record);
      const candidates = new Map(record.materials.map(material => [material.id, { material, documentIDs: [], applicationPDF: false }]));
      for (const document of state.documents.filter(document => document.sourceRecords.some(source => source.id === record.id))) {
        for (const material of document.materials) {
          const candidate = candidates.get(material.id) || { material, documentIDs: [], applicationPDF: false };
          candidate.documentIDs.push(document.id);
          if (document.purpose === 'application' && document.status === 'ready' && !document.stale && /\.pdf$/i.test(material.filename)) candidate.applicationPDF = true;
          candidates.set(material.id, candidate);
        }
      }
      for (const { material, documentIDs, applicationPDF } of candidates.values()) {
        const id = deliveryKey(record.id, material.id);
        const row = saved.get(id);
        const usableBusinessFormat = !/\.(json|txt)$/i.test(material.filename);
        const required = applicationPDF || (usableBusinessFormat && (['invoice', 'payment'].includes(material.role) || (material.role === 'statement' && !/\.docx$/i.test(material.filename))));
        const status = row?.status || 'unknown';
        items.push({ id, recordID: record.id, materialID: material.id, status, effectiveStatus: financeCompleted ? 'submitted' : status, completedByApproval: approvalCompleted, completedByFinance: financeCompleted, financeReviewPending: record.financeReviewPending === true, updatedAt: row?.updated_at || null, actor: row ? JSON.parse(row.actor) : null, note: row?.note || '', version: row ? version('delivery', id) : 'new', required, integrity: material.integrity, documentIDs });
      }
    }
    return items;
  }
  function setDelivery(recordID, payload, actor = humanActor) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['materialID', 'status', 'baseVersion', 'note'].includes(key))) fail('交付记录格式无效。');
    if (!clean(payload.materialID) || !['unknown', 'submitted', 'not_submitted'].includes(payload.status) || (payload.note !== undefined && typeof payload.note !== 'string')) fail('交付材料和状态无效。');
    if (actor.type === 'agent' && !clean(payload.note)) fail('Agent 登记交付状态必须写明用户反馈或交付事实依据。');
    return transaction(() => {
      recordRow(recordID);
      const item = workspace().deliveryItems.find(item => item.recordID === recordID && item.materialID === payload.materialID);
      if (!item) fail('交付文件必须是这笔记录的材料，或明确引用该记录的生成文档。', 409);
      expectVersion('delivery', item.id, payload.baseVersion, item.version !== 'new');
      if (payload.status === 'submitted') evidenceCheck([payload.materialID]);
      const at = currentTime();
      const note = clean(payload.note);
      db.prepare('INSERT INTO delivery_items VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_id,material_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,actor=excluded.actor,note=excluded.note').run(item.id, recordID, payload.materialID, payload.status, at, JSON.stringify(actor), note);
      const nextVersion = touch('delivery', item.id, actor, note || `交给财务秘书的文件状态：${payload.status}`);
      event('delivery_updated', `${actor.type === 'agent' ? 'Agent 记录反馈' : '用户维护'}：财务秘书文件交付状态为 ${payload.status}`, { recordID, materialID: payload.materialID, before: item.status, after: payload.status, actor, note, version: nextVersion });
      return { ...item, status: payload.status, effectiveStatus: item.completedByFinance ? 'submitted' : payload.status, updatedAt: at, actor, note, version: nextVersion };
    });
  }
  function importRecordMaterial(recordID, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['filename', 'role', 'contentBase64', 'baseVersion', 'note'].includes(key))) fail('上传材料格式无效。');
    if (!['invoice', 'payment'].includes(payload.role) || !clean(payload.filename) || typeof payload.contentBase64 !== 'string' || (payload.note !== undefined && typeof payload.note !== 'string')) fail('上传须提供发票或付款材料、文件名和Base64内容。');
    if (!/\.(pdf|png|jpg|jpeg|webp|gif|heic)$/i.test(payload.filename)) fail('此上传入口仅支持图片与 PDF 原件。');
    return transaction(() => {
      recordRow(recordID);
      expectVersion('record', recordID, payload.baseVersion);
      const result = importMaterial({ filename: payload.filename, role: payload.role, contentBase64: payload.contentBase64, recordID, source: { kind: 'user-upload', capturedAt: currentTime(), note: clean(payload.note) || '用户通过本地工作台上传原始材料；尚未据此自动核验付款。' } }, { baseVersion: payload.baseVersion, actor: humanActor });
      event('material_uploaded', `用户上传${payload.role === 'payment' ? '付款材料' : '发票'}：${result.filename}`, { recordID, materialID: result.id, actor: humanActor, note: clean(payload.note) });
      return result;
    });
  }
  function assertPolicyPDF(filename, bytes, provenance) {
    if (path.extname(filename).toLowerCase() !== '.pdf' || !/^%PDF-\d\.\d/.test(bytes.subarray(0, 16).toString('latin1')) || !/%%EOF\s*$/.test(bytes.subarray(-2048).toString('latin1'))) fail('规则依据必须是完整的 PDF 原件，不能使用改名文件或截断内容。');
    if (!['user-upload', 'browser-download'].includes(provenance?.kind)) fail('规则依据必须来自用户提供或官网下载的原始 PDF，不能使用生成文档或网页转录。');
  }
  function policyViews(materials = ctx.allMaterials()) {
    return db.prepare('SELECT * FROM policy_documents ORDER BY rowid DESC').all().map(row => {
      const raw = JSON.parse(row.raw);
      const material = materials.find(item => item.id === raw.materialID) || null;
      return { ...raw, version: version('policy', row.id), material, integrity: material?.integrity || 'missing' };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  function registerPolicy(p, c) {
    const old = db.prepare('SELECT * FROM policy_documents WHERE id=?').get(p.id);
    expectVersion('policy', p.id, c.baseVersion, !!old);
    if (![p.id, p.title, p.versionLabel].every(clean) || p.clauses.some(clause => ![clause.id, clause.topic, clause.section, clause.quote, clause.interpretation, clause.scope].every(clean))) fail('规则名称、版本和条款文本不能为空。');
    if (new Set(p.clauses.map(clause => clause.id)).size !== p.clauses.length) fail('同一规则文件中的条款 ID 不能重复。');
    const [material] = evidenceCheck([p.materialID]);
    if (material.role !== 'policy') fail('规则依据必须关联 role=policy 的 PDF 原件。');
    const file = ctx.material(p.materialID);
    assertPolicyPDF(material.filename, readFileSync(file.path), material.source);
    const at = currentTime();
    const raw = { ...p, createdAt: old ? JSON.parse(old.raw).createdAt : at, updatedAt: at, actor: c.actor };
    db.prepare('INSERT INTO policy_documents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET raw=excluded.raw').run(p.id, JSON.stringify(raw));
    touch('policy', p.id, c.actor, p.note || '维护规则依据及条款引用');
    return policyViews().find(item => item.id === p.id);
  }
  function uploadPolicy(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key => !['filename', 'contentBase64', 'title', 'versionLabel', 'note', 'operationId'].includes(key))) fail('上传规则依据格式无效。');
    if (![p.filename, p.title, p.versionLabel, p.operationId].every(clean) || typeof p.contentBase64 !== 'string' || typeof p.note !== 'string') fail('上传规则依据须提供 PDF、标题、版本、说明和 operationId。');
    const c = { type: 'policy.upload', operationId: p.operationId, payload: p, actor: humanActor };
    return runOperation(c, () => {
      const material = importMaterial({ filename: p.filename, contentBase64: p.contentBase64, role: 'policy', source: { kind: 'user-upload', capturedAt: currentTime(), note: p.note || '用户通过本地工作台上传的制度 PDF 原件。' } }, c);
      const id = `policy:${material.sha256}`;
      const existing = policyViews().find(item => item.id === id || item.materialID === material.id);
      if (existing) return existing;
      return registerPolicy({ id, title: p.title, versionLabel: p.versionLabel, materialID: material.id, status: 'reference', note: p.note, clauses: [] }, { ...c, baseVersion: 'new' });
    });
  }
  function updatePolicy(id, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => ![...Object.keys(policyFields).filter(key => key !== 'id'), 'baseVersion', 'operationId'].includes(key))) fail('维护规则依据格式无效。');
    const { baseVersion, operationId, ...fields } = payload;
    const p = { ...fields, id };
    const validate = validators.get('policy.register');
    if (!validate({ baseVersion, operationId, payload: p })) fail(`规则依据格式无效：${ajv.errorsText(validate.errors)}`);
    if (!db.prepare('SELECT id FROM policy_documents WHERE id=?').get(id)) fail('规则依据不存在。', 404);
    const c = { type: 'policy.register', operationId, baseVersion, payload: p, actor: humanActor };
    return runOperation(c, () => registerPolicy(p, c));
  }
  function importMaterial(p, c) {
    const filename = p.filename.split(/[\\/]/).pop();
    if (!filename || filename.includes('\0')) fail('文件名无效。');
    const extension = path.extname(filename).toLowerCase();
    if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.docx', '.csv', '.xlsx', '.json', '.txt'].includes(extension)) fail('材料格式不支持。');
    if (p.contentBase64.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) fail('材料不能超过 20 MB。', 413);
    if (p.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.contentBase64)) fail('材料必须为有效 Base64。');
    const bytes = Buffer.from(p.contentBase64, 'base64');
    if (bytes.toString('base64') !== p.contentBase64) fail('材料必须为有效 Base64。');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail('材料大小须在 1 字节到 20 MB 之间。', 413);
    if (p.role === 'policy') assertPolicyPDF(filename, bytes, p.source);
    if (p.recordID) { recordRow(p.recordID); expectVersion('record', p.recordID, c.baseVersion); }
    const sha256 = digest(bytes);
    const id = `material:${sha256}:${p.role}`;
    const stored = `${sha256}${extension}`;
    const destination = path.join(originals, stored);
    if (!existsSync(destination)) writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    if (digest(readFileSync(destination)) !== sha256) fail('材料原件哈希校验失败。', 409);
    const present = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
    if (!present) {
      const raw = { id, filename, role: p.role, sha256, source: p.source, actor: c.actor, importedAt: currentTime() };
      db.prepare('INSERT INTO materials VALUES (?,?,?,?,?,?,?)').run(id, filename, p.role, sha256, stored, 0, JSON.stringify(raw));
      touch('material', id, c.actor, '保存原始材料');
    }
    if (p.recordID && attach(p.recordID, [id]) > 0) touch('record', p.recordID, c.actor, '关联原始材料');
    return { ...ctx.allMaterials().find(item => item.id === id), duplicate: !!present, recordVersion: p.recordID ? version('record', p.recordID) : null };
  }
  function invoice(p, c) {
    evidenceCheck(p.evidenceIDs);
    const old = db.prepare('SELECT * FROM records WHERE id=?').get(p.id);
    expectVersion('record', p.id, c.baseVersion, !!old);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(`${p.date}T00:00:00Z`)) || new Date(`${p.date}T00:00:00Z`).toISOString().slice(0,10) !== p.date) fail('发票日期无效。');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.billingMonth)) fail('账单月份无效。');
    parseMoney(p.amount, { positive: true });
    const duplicate = db.prepare('SELECT id FROM records WHERE id<>? AND json_extract(raw,\'$.accountID\')=? AND json_extract(raw,\'$.invoiceNumber\')=?').get(p.id, p.accountID, p.invoiceNumber);
    if (duplicate) fail(`该账号的发票已存在：${duplicate.id}。请读取并更新已有记录。`, 409);
    const account = db.prepare('SELECT raw FROM accounts WHERE id=?').get(p.accountID);
    if (account && JSON.parse(account.raw).vendor !== p.vendor) fail('账号供应商与发票供应商不一致。', 409);
    if (!account) db.prepare('INSERT INTO accounts VALUES (?,?)').run(p.accountID, JSON.stringify({ id: p.accountID, name: p.accountName, vendor: p.vendor }));
    const { evidenceIDs, accountName, vendor, ...fields } = p;
    const raw = { ...(old ? JSON.parse(old.raw) : {}), ...fields };
    if (old && ['accountID', 'amount', 'currency', 'date', 'billingMonth', 'invoiceNumber'].some(key => JSON.parse(old.raw)[key] !== raw[key])) {
      if (db.prepare('SELECT id FROM allocations WHERE record_id=? LIMIT 1').get(p.id)) fail('已有关联审批，修改发票金额或身份前请先处理分摊。', 409);
      db.prepare('UPDATE records SET payment_verified=0,claim_confirmed=0 WHERE id=?').run(p.id);
    }
    db.prepare('INSERT INTO records(id,raw) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET raw=excluded.raw').run(p.id, JSON.stringify(raw));
    attach(p.id, evidenceIDs);
    touch('record', p.id, c.actor, '录入或更新发票事实');
    return workspace().records.find(item => item.id === p.id);
  }
  function patchRecord(p, c) {
    expectVersion('record', p.recordID, c.baseVersion);
    evidenceCheck(p.evidenceIDs);
    const row = recordRow(p.recordID);
    if (!['paymentVerified', 'claimConfirmed', 'claimedCNY', 'submissionReference', 'submittedOn'].some(key => Object.hasOwn(p, key))) fail('没有指定需要更新的业务字段。');
    attach(p.recordID, p.evidenceIDs);
    return ctx.reviewRecord(p.recordID, { paymentVerified: !!row.payment_verified, claimConfirmed: !!row.claim_confirmed, claimedCNY: formatMoney(row.claim_cents), submissionReference: row.submission_reference, submittedOn: row.submitted_on, ...p }, c.actor);
  }
  function upsertARP(p, c) {
    evidenceCheck(p.evidenceIDs);
    if (p.approvalVerified && (!p.approvalEvidenceID || !p.evidenceIDs.includes(p.approvalEvidenceID))) fail('已核实审批必须关联完整审批证据。', 409);
    if (p.approvalEvidenceID) evidenceCheck([p.approvalEvidenceID]);
    const old = db.prepare('SELECT * FROM arp_records WHERE id=?').get(p.id);
    expectVersion('arp', p.id, c.baseVersion, !!old);
    const previousRaw = old ? JSON.parse(old.raw) : {};
    const duplicate = db.prepare('SELECT id FROM arp_records WHERE id<>? AND json_extract(raw,\'$.reimbursementNumber\')=?').get(p.id, p.reimbursementNumber);
    if (duplicate) fail(`ARP 报销编号已存在：${duplicate.id}。请更新已有记录。`, 409);
    parseMoney(p.claimedCNY);
    parseMoney(p.approvedCNY || '', { optional: !p.approvalVerified, positive: p.approvalVerified });
    const approvedCents = parseMoney(p.approvedCNY || '0');
    const reservedCents = parseMoney(p.reservedCNY ?? previousRaw.reservedCNY ?? '0');
    const reserveReason = clean(p.reserveReason ?? previousRaw.reserveReason ?? '');
    if (reservedCents > 0 && !reserveReason) fail('范围外预留金额必须填写凭证依据和费用范围。', 409);
    if (reservedCents > approvedCents) fail('范围外预留金额不能超过原始审批金额。', 409);
    if (p.approvalVerified && (!/生成凭证|审批通过|审核通过|已批准|已完成|已报销|^approved$|^completed$/i.test(p.status) || p.hasUnresolvedAdjustment)) fail('当前审批状态或未解决调整不支持核实审批。', 409);
    const used = db.prepare('SELECT amount_cents FROM allocations WHERE arp_id=?').all(p.id).reduce((a, b) => a + BigInt(b.amount_cents), 0n);
    if (used + BigInt(reservedCents) > BigInt(approvedCents)) fail('原始审批金额扣除范围外预留后不能低于已有分摊。', 409);
    const raw = { ...previousRaw, id: p.id, reimbursementNumber: p.reimbursementNumber, summary: p.summary || '', rawStatus: p.status, claimedAmountCNY: p.claimedCNY, approvedAmountCNY: p.approvedCNY || '', reservedCNY: formatMoney(reservedCents), reserveReason, approvalVerified: p.approvalVerified, hasUnresolvedAdjustment: !!p.hasUnresolvedAdjustment, sourceReference: `material:${p.evidenceIDs[0]}`, approvalSourceReference: p.approvalEvidenceID ? `material:${p.approvalEvidenceID}` : '', evidenceIDs: p.evidenceIDs, sourceLabel: p.sourceLabel, observedAt: p.observedAt };
    db.prepare('INSERT INTO arp_records VALUES (?,?) ON CONFLICT(id) DO UPDATE SET raw=excluded.raw').run(p.id, JSON.stringify(raw));
    touch('arp', p.id, c.actor, '记录 ARP 来源与审批事实');
    for (const row of db.prepare('SELECT DISTINCT record_id FROM allocations WHERE arp_id=?').all(p.id)) touch('record', row.record_id, c.actor, '关联审批来源更新');
    return workspace().arpRecords.find(item => item.id === p.id);
  }
  function registerDocument(p, c) {
    const materials = evidenceCheck(p.materialIDs);
    evidenceCheck(p.sourceMaterialIDs);
    if (!materials.every(item => /\.(docx|pdf)$/i.test(item.filename))) fail('生成文档必须关联 DOCX/PDF 文件。');
    if (p.status === 'ready' && (!materials.some(item => /\.docx$/i.test(item.filename)) || !materials.some(item => /\.pdf$/i.test(item.filename)))) fail('ready 文档必须同时保留 Word 与 PDF。', 409);
    const old = db.prepare('SELECT * FROM generated_documents WHERE id=?').get(p.id);
    expectVersion('document', p.id, c.baseVersion, !!old);
    const purpose = p.purpose || (old ? JSON.parse(old.raw).purpose : null) || 'review';
    const sourceRecords = p.recordIDs.map(id => { recordRow(id); expectVersion('record', id, p.sourceRecordVersions[id]); return { id, version: p.sourceRecordVersions[id] }; });
    if (purpose === 'application' && p.status === 'ready') {
      const issues = applicationIssues(p, workspace());
      if (issues.length) fail(issues.join(' '), 409);
    }
    const raw = { ...p, purpose, sourceRecords, registeredAt: currentTime(), actor: c.actor };
    db.prepare('INSERT INTO generated_documents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET raw=excluded.raw').run(p.id, JSON.stringify(raw));
    touch('document', p.id, c.actor, '登记生成的 Word/PDF 及来源');
    return workspace().documents.find(item => item.id === p.id);
  }
  function applicationIssues(document, state) {
    const issues = [];
    const records = document.recordIDs || document.sourceRecords?.map(source => source.id) || [];
    const outputs = (document.materialIDs || []).map(id => state.materials.find(material => material.id === id));
    const sources = document.sourceMaterialIDs || [];
    if (!records.length) issues.push('正式申请包必须覆盖至少一笔报销记录。');
    if (!outputs.some(material => material?.integrity === 'ok' && ['document', 'statement'].includes(material.role) && /\.docx$/i.test(material.filename))) issues.push('申请包缺少有效的情况说明 DOCX。');
    const submission = outputs.find(material => material?.id === document.submissionPDFMaterialID);
    if (!submission || submission.integrity !== 'ok' || !['document', 'statement'].includes(submission.role) || !/\.pdf$/i.test(submission.filename)) issues.push('请用 submissionPDFMaterialID 明确登记整合情况说明、发票、付款截图和汇率截图的提交 PDF。');
    for (const id of records) {
      const record = state.records.find(record => record.id === id);
      if (!record) { issues.push(`申请包引用的记录 ${id} 不存在。`); continue; }
      if (!record.paymentVerified || !record.claimConfirmed || parseMoney(record.claimedCNY || '0') <= 0) issues.push(`记录 ${id} 的付款事实及正数人民币申报口径尚未确认，申请包只能保留为草稿。`);
      for (const role of ['invoice', 'payment']) {
        if (!record.materials.some(material => material.role === role && material.integrity === 'ok' && sources.includes(material.id))) issues.push(`申请包缺少记录 ${id} 的有效${role === 'invoice' ? '发票' : '付款'}原件来源。`);
      }
      const rate = record.exchangeRate;
      if (record.currency !== 'CNY') {
        if (!rate?.valid) issues.push(`记录 ${id} 缺少有效的发票日期中行折算价及官网截图。${rate?.issues.join(' ') || ''}`);
        else if (!rate.evidenceIDs.every(id => sources.includes(id))) issues.push(`申请包未包含记录 ${id} 的中行官网汇率截图来源。`);
      }
      const expectedCNY = record.currency === 'CNY' ? record.amount : rate?.valid ? rate.cnyAmount : null;
      if (expectedCNY && record.claimConfirmed && parseMoney(record.claimedCNY || '0') !== parseMoney(expectedCNY)) issues.push(`记录 ${id} 已确认申报 ¥${record.claimedCNY} 与${record.currency === 'CNY' ? '发票金额' : '发票日中行换算'} ¥${expectedCNY} 不一致；保留原申报金额，差额需明确核对。`);
    }
    return issues;
  }
  function setExchangeRate(p, c) {
    const row = recordRow(p.recordID);
    expectVersion('record', p.recordID, c.baseVersion);
    const materials = evidenceCheck(p.evidenceIDs);
    const record = workspace().records.find(record => record.id === p.recordID);
    const { recordID, ...fields } = p;
    const rate = { ...fields, recordedAt: currentTime(), actor: c.actor };
    const checked = exchangeRateView({ ...record, exchangeRate: rate, materials });
    if (!checked.valid) fail(checked.issues.join(' '), 409);
    const raw = { ...JSON.parse(row.raw), exchangeRate: rate };
    db.prepare('UPDATE records SET raw=? WHERE id=?').run(JSON.stringify(raw), recordID);
    attach(recordID, p.evidenceIDs);
    touch('record', recordID, c.actor, `登记发票日中行折算价：${p.quotedRate}/100 ${p.currency}；${p.note}`);
    event('exchange_rate_recorded', `${record.invoiceNumber} 使用 ${p.date} 中行折算价 ${p.quotedRate}，换算 ¥${checked.cnyAmount}；已有申报金额保持不变。`, { recordID, actor: c.actor, exchangeRate: rate, calculatedCNY: checked.cnyAmount });
    return workspace().records.find(record => record.id === recordID);
  }
  function history(p) {
    const predicates = [], args = [];
    if (p.entityType) { predicates.push('entity_type=?'); args.push(p.entityType); }
    if (p.entityID) { predicates.push('entity_id=?'); args.push(p.entityID); }
    return { syncEnabled: false, deviceID, changes: db.prepare(`SELECT * FROM version_history ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, p.limit || 100).map(row => ({ cursor: row.id, entityType: row.entity_type, entityID: row.entity_id, version: row.version, at: row.at, actor: JSON.parse(row.actor), reason: row.reason, snapshot: JSON.parse(row.snapshot) })) };
  }
  function tasks() {
    const state = workspace();
    function approvalDetail(record) {
      if (record.financeReviewPending) return { status: 'pending_approval', detail: `${record.submissionReference} 财务审核中；按规则前四步已完成，等待财务全部审核通过。` };
      const submitted = state.arpRecords.find(item => item.reimbursementNumber === record.submissionReference);
      if (submitted && !submitted.approvalVerified && /审核/.test(submitted.status)) {
        return { status: 'pending_approval', detail: `${submitted.reimbursementNumber} 已登记提交，当前${submitted.status}；本笔 ¥${record.outstandingCNY} 等待审批结果。` };
      }
      return { status: 'needs_evidence', detail: `尚有 ¥${record.outstandingCNY} 未关联经核实审批；需核查审批结果与账单对应依据。` };
    }
    function applicationTask(record) {
      const applications = state.documents.filter(document => document.purpose === 'application' && document.sourceRecords.some(source => source.id === record.id));
      if (applications.some(document => document.ready && !document.stale && !document.needsUpdate)) return [];
      const status = applications.some(document => document.stale) ? 'stale' : applications.length ? 'draft' : 'missing';
      const detail = status === 'stale' ? '申请材料包的来源或记录版本已变化；需根据当前材料更新情况说明 Word/PDF 并重新登记。' : status === 'draft' ? '申请材料包仍为草稿；需补齐付款原件、确认付款与人民币申报口径，并完成情况说明 Word/PDF。' : '尚无当前有效的正式申请材料包；需由 Agent 根据原件与已确认申报口径制作情况说明 Word/PDF，核对报告不代替申请材料。';
      return [{ id: `${record.id}:application`, recordID: record.id, kind: 'application', status, detail }];
    }
    const tasks = state.records.flatMap(record => completedByApproval(record) ? [] : record.financeReviewPending ? [
      { id: `${record.id}:approval`, recordID: record.id, kind: 'approval', ...approvalDetail(record) },
    ] : [
      ...record.issues.map((detail, index) => ({ id: `${record.id}:issue:${index}`, recordID: record.id, kind: 'workflow', status: 'needs_evidence', detail })),
      ...(record.currency !== 'CNY' && !record.exchangeRate?.valid ? [{ id: `${record.id}:exchange-rate`, recordID: record.id, kind: 'exchange_rate', status: record.exchangeRate ? 'invalid' : 'missing', detail: record.exchangeRate ? record.exchangeRate.issues.join(' ') : `缺少发票日期 ${record.date} 的中国银行中行折算价及官网原始截图（每100 ${record.currency} 兑人民币）。` }] : []),
      ...(record.currency !== 'CNY' && record.exchangeRate?.valid && record.claimConfirmed && parseMoney(record.claimedCNY || '0') !== parseMoney(record.exchangeRate.cnyAmount) ? [{ id: `${record.id}:exchange-rate-claim`, recordID: record.id, kind: 'exchange_rate', status: 'claim_mismatch', detail: `已确认申报 ¥${record.claimedCNY} 与发票日中行换算 ¥${record.exchangeRate.cnyAmount} 不一致；原申报金额未修改，需核对差额。` }] : []),
      ...applicationTask(record),
      ...(!record.submissionReference && !record.submittedOn ? [{ id: `${record.id}:submission`, recordID: record.id, kind: 'submission', status: 'pending', detail: '没有登记 ARP 提交信息；不推定尚未提交。' }] : []),
      ...(record.claimConfirmed && record.outstandingCNY && parseMoney(record.outstandingCNY) > 0 ? [{ id: `${record.id}:approval`, recordID: record.id, kind: 'approval', ...approvalDetail(record) }] : []),
      ...(record.humanVerification.status !== 'verified' ? [{ id: `${record.id}:verify`, recordID: record.id, kind: 'human_verification', status: record.humanVerification.status, detail: '请通过 UI 核验当前版本；Agent 不可代替人工确认。' }] : []),
    ]);
    tasks.push(...state.deliveryItems.filter(item => item.required && item.effectiveStatus !== 'submitted').map(item => ({ id: `${item.id}:feedback`, recordID: item.recordID, materialID: item.materialID, kind: 'delivery', status: 'needs_user_feedback', deliveryStatus: item.status, deliveryVersion: item.version, detail: `${state.materials.find(material => material.id === item.materialID)?.filename || item.materialID}：${item.status === 'unknown' ? '是否已交给财务秘书尚待用户反馈' : '当前记录为未交给财务秘书，实际交付后请更新'}；此项不表示 ARP 提交或审批状态。${item.integrity !== 'ok' ? '原件缺失或变化，恢复有效原件前不能登记为已交付。' : ''}` })));
    tasks.push(...state.gaps.map(gap => ({ id: `coverage:${gap.month}`, kind: 'coverage', status: 'unverified', ...gap, detail: gap.reason })));
    tasks.push(...state.sources.filter(item => ['needs_login', 'blocked', 'partial'].includes(item.status)).map(item => ({ id: `source:${item.id}`, kind: 'source', status: item.status, detail: item.detail })));
    return { generatedAt: currentTime(), completedByApprovalRecordIDs: state.records.filter(completedByApproval).map(record => record.id), financeReviewPendingRecordIDs: state.records.filter(record => record.financeReviewPending).map(record => record.id), priorStepsCompleteRecordIDs: state.records.filter(completedByFinance).map(record => record.id), tasks };
  }
  function execute(c) {
    if (!c || typeof c !== 'object' || !c.actor || c.actor.type !== 'agent' || !clean(c.actor.id)) fail('Agent 接口必须明确 actor.type=agent，不能冒充人工核验。', 403);
    if (Object.keys(c).some(key => !['type', 'operationId', 'baseVersion', 'payload', 'actor'].includes(key))) fail('命令含有不支持的字段。');
    const entry = catalog.find(item => item.name === c.type);
    if (!entry) fail('未知 Agent 命令。', 404);
    const input = { ...(c.operationId != null ? { operationId: c.operationId } : {}), ...(c.baseVersion != null ? { baseVersion: c.baseVersion } : {}), ...(c.payload != null ? { payload: c.payload } : {}) };
    const validate = validators.get(c.type);
    if (!validate(input)) fail(`命令格式无效：${ajv.errorsText(validate.errors)}`);
    const p = c.payload || {};
    if (entry.readOnly) {
      if (c.type === 'workspace.get') return workspace();
      if (c.type === 'tasks.list') return tasks();
      return history(p);
    }
    return runOperation(c, () => {
      let data;
      if (c.type === 'material.import') data = importMaterial(p, c);
      else if (c.type === 'policy.register') data = registerPolicy(p, c);
      else if (c.type === 'invoice.upsert') data = invoice(p, c);
      else if (c.type === 'record.patch') data = patchRecord(p, c);
      else if (c.type === 'exchangeRate.set') data = setExchangeRate(p, c);
      else if (c.type === 'arp.upsert') data = upsertARP(p, c);
      else if (c.type === 'document.register') data = registerDocument(p, c);
      else if (c.type === 'delivery.set') {
        const { recordID, ...fields } = p;
        data = setDelivery(recordID, { ...fields, baseVersion: c.baseVersion }, c.actor);
      }
      else if (c.type === 'allocation.create') {
        expectVersion('record', p.recordID, c.baseVersion);
        evidenceCheck(p.evidenceIDs);
        data = { ...ctx.allocate(p, c.actor), recordVersion: version('record', p.recordID) };
      } else if (c.type === 'allocation.remove') {
        const row = db.prepare('SELECT * FROM allocations WHERE id=?').get(p.allocationID);
        if (!row) fail('分摊不存在。', 404);
        expectVersion('record', row.record_id, c.baseVersion);
        data = { ...ctx.removeAllocation(p.allocationID, c.actor), recordVersion: version('record', row.record_id) };
      } else if (c.type === 'source.update') {
        evidenceCheck(p.evidenceIDs);
        if (p.status === 'complete' && (!p.evidenceIDs.length || !p.coverageFrom || !p.coverageTo)) fail('完整采集声明必须包含证据与覆盖日期范围。', 409);
        db.prepare('INSERT INTO source_observations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET raw=excluded.raw').run(p.id, JSON.stringify(p));
        data = { ...p, version: touch('source', p.id, c.actor, '记录来源采集结果') };
      }
      return data;
    });
  }
  function runOperation(c, work) {
    if (!clean(c.operationId) || c.operationId.length > 160) fail('operationId 须为 1 到 160 字符。');
    const requestHash = digest(stable(c));
    return transaction(() => {
      const previous = db.prepare('SELECT * FROM agent_operations WHERE operation_id=?').get(c.operationId);
      if (previous) {
        if (previous.request_hash !== requestHash) fail('operationId 已用于不同命令。请勿重复使用同一操作标识。', 409);
        return { ...JSON.parse(previous.result), replayed: true };
      }
      const data = work();
      const p = c.payload || {};
      event(c.actor.type === 'agent' ? 'agent_command' : 'human_command', `${c.actor.type === 'agent' ? `Agent ${c.actor.id}` : '用户'} 执行 ${c.type}`, { operationId: c.operationId, actor: c.actor, type: c.type, evidenceIDs: p.evidenceIDs || p.sourceMaterialIDs || (p.materialID ? [p.materialID] : []), note: p.note || p.basis || p.reason || '' });
      const result = { operationId: c.operationId, type: c.type, replayed: false, data };
      db.prepare('INSERT INTO agent_operations VALUES (?,?,?,?)').run(c.operationId, requestHash, JSON.stringify(result), currentTime());
      return result;
    });
  }
  return { execute, decorate, touch, verifyRecord, setDelivery, importRecordMaterial, uploadPolicy, updatePolicy, version, expectVersion, history, tasks };
}
