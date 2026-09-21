import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {Material, RecordItem, Workspace} from './types';
import {api, isRemoteAPI} from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import WorkflowView from './WorkflowView';
import {workspaceVendors} from './vendors';
import RecordWorkflowDrawer from './RecordWorkflowDrawer';
import PolicyLibrary from './PolicyLibrary';
import {AutomationToolbar} from './Automation';
import type {WorkflowStepId} from './workflow';

type IconName = 'grid' | 'receipt' | 'folder' | 'history' | 'arrow' | 'search' | 'refresh' | 'download' | 'plus' | 'close' | 'check' | 'info' | 'external' | 'upload' | 'chevron' | 'shield' | 'link';

const money = (value: string | null | undefined, currency = 'CNY') => value == null || value === '' ? '待确认' : `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `}${value}`;
const asCents = (value: string) => /^-?\d+(?:\.\d{1,2})?$/.test(value) ? BigInt(value.replace('-', '').split('.')[0]) * 100n * (value.startsWith('-') ? -1n : 1n) + BigInt((value.replace('-', '').split('.')[1] || '').padEnd(2, '0')) * (value.startsWith('-') ? -1n : 1n) : 0n;
const timeLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false }); };
const roleLabel = (role: string) => ({ invoice: '发票', payment: '付款凭证', receipt: '收据', approval: '审批材料', statement: '情况说明', arp: 'ARP 材料', exchangeRate: '汇率依据', policy: '制度原件', observation: '网页采集记录', document: '生成文档', other: '补充材料' })[role] || role || '原始材料';

function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const shapes: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 2h18" />,
    history: <><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    refresh: <><path d="M20 7a9 9 0 0 0-15-1L3 9m0-6v6h6M4 17a9 9 0 0 0 15 1l2-3m0 6v-6h-6" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.5" /></>,
    external: <><path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 16v5h16v-5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 11 3 3 5-5" /></>,
    link: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1) scale(.9)" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{shapes[name]}</svg>;
}


function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name="folder" size={27} /></span><h3>{title}</h3><p>{children}</p></div>; }
function Feedback({ error, success }: { error?: string; success?: string }) { return error ? <div role="alert" className="feedback error"><Icon name="info" />{error}</div> : success ? <div role="status" className="feedback success"><Icon name="check" />{success}</div> : null; }
function MaterialLink({ material }: { material: Material }) { return <AuthenticatedFileLink className={`material-item ${material.integrity !== 'ok' ? 'material-warning' : ''}`} href={material.href} filename={material.filename}><span className="file-icon"><Icon name="receipt" /></span><span className="file-info"><strong>{material.filename}</strong><small>{roleLabel(material.role)} · {material.integrity === 'ok' ? '文件完整性校验通过' : material.integrity === 'missing' ? '原件缺失' : '原件已变更'}</small></span><Icon name="external" size={15} /></AuthenticatedFileLink>; }

export default function App() {
  const [data, setData] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<WorkflowStepId | undefined>();
  const [utility, setUtility] = useState<'policies' | 'materials' | 'arp' | 'activity' | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const records = data?.records || [];
  const selected = records.find(record => record.id === selectedId);
  const years = [...new Set(records.map(record => record.billingMonth.slice(0, 4)))].join(' / ') || '2026';

  async function reload(): Promise<Workspace> {
    setLoading(true);
    try {
      const result = await api<Workspace>('/api/workspace');
      setData(result); setError(''); return result;
    } catch (err) { setError(err instanceof Error ? err.message : '读取数据失败'); throw err; }
    finally { setLoading(false); }
  }
  function openRecord(id: string, step?: WorkflowStepId) { setUtility(null); setSelectedStep(step); setSelectedId(id); }
  function openUtility(value: 'policies' | 'materials' | 'arp' | 'activity') {
    if (menuRef.current) menuRef.current.open = false;
    setSelectedId(null); setUtility(value);
  }
  useEffect(() => { void reload().catch(() => {}); }, []);
  useEffect(() => {
    if (selectedId || utility) return;
    let active = true, inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const next = await api<Workspace>('/api/workspace');
        if (active) setData(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      } catch { /* An explicit refresh displays connection errors. */ }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void refresh(), 10000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [selectedId, utility]);

  return <div className="reimbursement-app">
    <main className="workbench-main">
      <header className="workbench-header">
        <div className="workbench-identity"><span className="workbench-mark"><Icon name="receipt" size={24} /></span><div><h1>报销流程</h1><p><span>{workspaceVendors(records)}</span><span>{years} 年</span><span>{isRemoteAPI() ? '云端工作区' : '本地工作区'}</span></p></div></div>
        <div className="workbench-actions">{data&&<AutomationToolbar data={data} onReload={reload}/>}<button className="button secondary" onClick={() => openUtility('policies')} disabled={!data}><Icon name="shield" size={16} />规则依据</button><button className="button secondary" onClick={() => void reload().catch(() => {})} disabled={loading}><Icon name="refresh" size={16} className={loading ? 'spin' : ''} />刷新</button><details className="workbench-menu" ref={menuRef}><summary className="button secondary">更多 <Icon name="chevron" size={14} /></summary><div className="workbench-menu-items"><button onClick={() => openUtility('materials')}>材料与来源</button><button onClick={() => openUtility('arp')}>ARP 原始记录</button><button onClick={() => openUtility('activity')}>操作记录</button><AuthenticatedFileLink href={'/api/export'} download="reimbursement-export.json">导出台账</AuthenticatedFileLink></div></details></div>
      </header>
      <Feedback error={error} />
      {data ? <WorkflowView data={data} onReload={reload} onOpenRecord={openRecord} onOpenMaterials={() => openUtility('materials')} onOpenARP={() => openUtility('arp')} /> : loading ? <div className="loading-state"><Icon name="refresh" className="spin" /><p>正在读取台账…</p></div> : <Empty title="无法读取台账">请确认本地服务已启动，再刷新页面。</Empty>}
      <footer className="workbench-footer"><span>财务审核中：前四步完成；全部通过：五步完成。</span><span>{isRemoteAPI() ? '数据保存在服务器' : '数据保存在本机'}</span></footer>
    </main>
    {selected && data && <RecordWorkflowDrawer key={selected.id} data={data} record={selected} initialStep={selectedStep} onClose={() => setSelectedId(null)} onReload={reload} onOpenMaterials={() => openUtility('materials')} materials={<>{selected.materials.map(material => <MaterialLink key={material.id} material={material} />)}{!selected.materials.length && <p className="small-muted">尚未保存原始材料。</p>}</>} approval={controls => <><AllocationForm data={data} fixedRecord={selected} onReload={reload} onDirty={controls.onDirty} onBusy={controls.onBusy} disabled={controls.busy} /><AllocationList data={data} recordID={selected.id} onReload={reload} onBusy={controls.onBusy} disabled={controls.busy} /></>} />}
    {utility && data && <UtilityPanel title={{policies:'规则依据',materials:'材料与来源',arp:'ARP 原始记录',activity:'操作记录'}[utility]} onClose={() => setUtility(null)}>
      {utility === 'policies' && <PolicyLibrary data={data} onReload={reload} />}
      {utility === 'materials' && <MaterialsView data={data} onReload={reload} onSelect={id => openRecord(id)} />}
      {utility === 'arp' && <ARPView data={data} onReload={reload} onSelect={id => openRecord(id, 'approval')} />}
      {utility === 'activity' && <div className="timeline">{data.events.map(event => <div key={event.id} className="timeline-item"><span className="timeline-dot"><Icon name="check" size={13} /></span><div><strong>{event.summary}</strong><p>{timeLabel(event.at)}</p></div></div>)}</div>}
    </UtilityPanel>}
  </div>;
}

function UtilityPanel({title, children, onClose}: {title:string; children:ReactNode; onClose:()=>void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.showModal();
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog className="utility-dialog" ref={ref} onCancel={event => {event.preventDefault(); onClose();}}>
    <header className="utility-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭补充资料" onClick={onClose}><Icon name="close" /></button></header>
    <div className="utility-body">{children}</div>
  </dialog>;
}

function AllocationForm({ data, fixedRecord, onReload, onDirty, onBusy, disabled = false }: { data: Workspace; fixedRecord?: RecordItem; onReload: () => Promise<Workspace>; onDirty?: (value: boolean) => void; onBusy?: (value: boolean) => void; disabled?: boolean }) {
  const [recordID, setRecordID] = useState(fixedRecord?.id || '');
  const [arpID, setArpID] = useState('');
  const [amountCNY, setAmountCNY] = useState('');
  const [basis, setBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const selectedARP = data.arpRecords.find(item => item.id === arpID);
  const selectedRecord = fixedRecord || data.records.find(item => item.id === recordID);
  const dirty = Boolean(arpID || amountCNY || basis || (!fixedRecord && recordID));
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || disabled) return;
    setSaving(true); onBusy?.(true); setError(''); setSuccess('');
    let committed = false;
    try {
      await api('/api/allocations', { method: 'POST', body: JSON.stringify({ recordID: fixedRecord?.id || recordID, arpID, amountCNY, basis }) });
      committed = true;
      setArpID(''); setAmountCNY(''); setBasis(''); if (!fixedRecord) setRecordID('');
      await onReload(); setSuccess('审批金额已关联，台账状态已更新。');
    }
    catch (err) { setError(committed ? '审批关联已保存，但未能刷新台账。请刷新后核对结果，不要重复关联。' : err instanceof Error ? err.message : '关联失败'); }
    finally { setSaving(false); onBusy?.(false); }
  }
  return <form className="allocation-form" onSubmit={submit}><fieldset className="workflow-form-fields" disabled={saving || disabled}><p className="form-hint">仅可关联有完整原件支持的已核实审批；关联金额不能超过本笔申报金额或审批剩余额度。</p>{!fixedRecord && <label className="field-label">对应订阅记录<select required value={recordID} onChange={event => setRecordID(event.target.value)}><option value="">选择一笔订阅记录</option>{data.records.map(record => <option key={record.id} value={record.id}>{record.billingMonth} · {record.invoiceNumber} · {record.claimConfirmed ? money(record.claimedCNY) : '申报待确认'}</option>)}</select></label>}<label className="field-label">ARP 审批来源<select required value={arpID} onChange={event => setArpID(event.target.value)}><option value="">选择已核实的审批记录</option>{data.arpRecords.map(item => <option key={item.id} value={item.id} disabled={!item.approvalVerified || asCents(item.availableCNY) <= 0n}>{item.reimbursementNumber} · 可用 {money(item.availableCNY)}{!item.approvalVerified ? ' · 待核实' : ''}</option>)}</select></label>{selectedARP && <div className="allocation-context"><strong>{selectedARP.summary}</strong><span>{selectedARP.sourceLabel}</span></div>}{selectedRecord && <p className="form-hint">本笔申报：{selectedRecord.claimConfirmed ? money(selectedRecord.claimedCNY) : '尚未确认'} · 尚待关联：{money(selectedRecord.outstandingCNY)}</p>}<label className="field-label">本次关联金额（人民币）<input required inputMode="decimal" value={amountCNY} onChange={event => setAmountCNY(event.target.value)} placeholder="0.00" /></label><label className="field-label">关联依据 <span className="required">必填</span><textarea required rows={2} value={basis} onChange={event => setBasis(event.target.value)} placeholder="说明这笔审批对应此发票的依据…" /></label><Feedback error={error} success={success} /><button type="submit" className="button secondary full-width" disabled={saving || !selectedRecord?.claimConfirmed}><Icon name="link" size={16} />{saving ? '正在关联…' : '确认关联金额'}</button>{selectedRecord && !selectedRecord.claimConfirmed && <p className="small-muted">请先保存并确认人民币申报金额。</p>}</fieldset></form>;
}

function AllocationList({ data, recordID, onReload, onBusy, disabled = false }: { data: Workspace; recordID?: string; onReload: () => Promise<Workspace>; onBusy?: (value: boolean) => void; disabled?: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmID, setConfirmID] = useState('');
  const allocations = data.allocations.filter(item => !recordID || item.recordID === recordID);
  async function remove(id: string) {
    if (busy || disabled) return;
    setBusy(id); onBusy?.(true); setError('');
    let committed = false;
    try { await api(`/api/allocations/${encodeURIComponent(id)}`, { method: 'DELETE' }); committed = true; setConfirmID(''); await onReload(); }
    catch (err) { setError(committed ? '关联已撤销，但未能刷新台账。请刷新后核对结果。' : err instanceof Error ? err.message : '撤销失败'); }
    finally { setBusy(''); onBusy?.(false); }
  }
  return <div className="allocation-list"><Feedback error={error} />{allocations.length ? allocations.map(item => <div className="allocation-item" key={item.id}><div className="allocation-top"><strong>{money(item.amountCNY)}</strong><button className="text-button danger-text" disabled={disabled || Boolean(busy)} onClick={() => setConfirmID(confirmID === item.id ? '' : item.id)}>撤销关联</button></div><p>{data.arpRecords.find(arp => arp.id === item.arpID)?.reimbursementNumber || item.arpID}{!recordID && ` → ${data.records.find(record => record.id === item.recordID)?.invoiceNumber || item.recordID}`}</p><p className="small-muted">{item.basis}</p>{confirmID === item.id && <div className="inline-confirm"><span>撤销后将重新计算报销状态。</span><button className="button danger small" disabled={disabled || Boolean(busy)} onClick={() => void remove(item.id)}>{busy === item.id ? '处理中…' : '确认撤销'}</button></div>}</div>) : <p className="small-muted no-allocations">尚未关联审批金额。审批通过不会自动归入某张发票。</p>}</div>;
}

function ARPView({ data, onSelect, onReload }: { data: Workspace; onSelect: (id: string) => void; onReload: () => Promise<Workspace> }) {
  return <><div className="notice"><span className="notice-icon"><Icon name="info" /></span><div><strong>审批依据和来源逐笔保留</strong><p>每笔记录保留采集时间和来源。ARP 已提交且全部审核通过后记为已报销，按规则默认到账。</p></div><a className="text-button" href="https://ihep.arp.cn" target="_blank" rel="noreferrer">打开 ARP <Icon name="external" size={15} /></a></div><div className="arp-layout"><section className="panel"><div className="section-heading"><div><h2>已导入的 ARP 记录</h2><p>逐条查看审批来源与剩余可关联金额</p></div><span className="subtle-label">{data.arpRecords.length} 笔</span></div>{data.arpRecords.map(item => <article className="arp-card" key={item.id}><div className="arp-card-top"><span className="document-mark"><Icon name="receipt" size={20} /></span><div><h3>{item.reimbursementNumber}</h3><p>{item.summary}</p></div><span className={`badge ${item.approvalVerified ? 'status-ready' : 'status-needs_review'}`}>{item.approvalVerified ? '审批事实已核实' : '审批待核实'}</span></div><div className="arp-amounts"><div><span>原始状态</span><strong>{item.status || '未知'}</strong></div><div><span>已批准金额</span><strong>{money(item.approvedCNY)}</strong></div><div><span>剩余可关联</span><strong className="teal-text">{money(item.availableCNY)}</strong></div></div><p className="source-caption"><Icon name="folder" size={14} />{item.sourceLabel}</p>{item.reservedCNY && asCents(item.reservedCNY) > 0n && <p className="form-hint">范围外已占用 {money(item.reservedCNY)} · {item.reserveReason}</p>}{item.materialIds.length > 0 && <div className="arp-material-links">{item.materialIds.map((id, index) => <AuthenticatedFileLink key={id} href={`/api/materials/${encodeURIComponent(id)}`}>查看审批证据 {index + 1}<Icon name="external" size={12} /></AuthenticatedFileLink>)}</div>}</article>)}{!data.arpRecords.length && <Empty title="暂无 ARP 记录">当前没有可用于对账的历史审批材料。</Empty>}<div className="subsection-heading"><h3>金额关联记录</h3><p>撤销关联只改变对账关系，保留操作历史。</p></div><AllocationList data={data} onReload={onReload} /></section><section className="panel association-panel"><div className="section-heading"><div><h2>关联审批金额</h2><p>把已批准金额分配到具体订阅</p></div><Icon name="link" size={20} /></div><AllocationForm data={data} onReload={onReload} /><div className="quick-records"><h3>待核验的订阅</h3>{data.records.filter(record => !record.claimConfirmed).map(record => <button key={record.id} onClick={() => onSelect(record.id)}><span>{record.billingMonth}<small>{record.invoiceNumber}</small></span><Icon name="chevron" size={16} /></button>)}</div></section></div></>;
}

function MaterialsView({ data, onReload, onSelect }: { data: Workspace; onReload: () => Promise<Workspace>; onSelect: (id: string) => void }) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const allMaterials = [...new Map((data.materials || data.records.flatMap(record => record.materials)).map(material => [material.id, material])).values()];
  async function importFile(file: File) {
    setError(''); setSuccess('');
    if (file.size > 10 * 1024 * 1024) { setError('CSV 文件不能超过 10 MB。'); return; }
    setImporting(true);
    try { await api('/api/import/apple-card', { method: 'POST', body: JSON.stringify({ filename: file.name, csv: await file.text() }) }); await onReload(); setSuccess('CSV 已导入。匹配结果仅作为核对候选，请打开对应订阅核验付款。'); }
    catch (err) { setError(err instanceof Error ? err.message : '导入失败'); }
    finally { setImporting(false); if (inputRef.current) inputRef.current.value = ''; }
  }
  return <><section className="sources-grid">{data.sources.map((source, index) => <article className="source-card" key={source.id}><div className="source-top"><span className={`source-monogram source-${index}`}>{source.name.toLowerCase().includes('apple') ? 'A' : source.name.toLowerCase().includes('arp') ? 'ARP' : 'O'}</span><span className="manual-badge">{({needs_login:"等待登录",blocked:"等待处理",partial:"已部分收集",complete:"已完成收集"} as Record<string,string>)[source.status] || "待核查"}</span></div><h2>{source.name}</h2><p>{source.detail}</p><a className="button secondary" href={source.url} target="_blank" rel="noreferrer">打开官方网站<Icon name="external" size={14} /></a></article>)}</section><section className="panel import-panel"><div className="import-intro"><span className="upload-mark"><Icon name="upload" size={25} /></span><div><h2>导入 Apple Card 付款记录</h2><p>选择从 Apple Card 导出的 CSV。自动筛选 OpenAI 相关交易并生成核对候选。</p><small>支持标准 Apple Card CSV · 最大 10 MB · 不会自动标记为已付款</small></div><input ref={inputRef} className="sr-only" type="file" accept=".csv,text/csv" aria-label="选择 Apple Card CSV" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /><button className="button primary" onClick={() => inputRef.current?.click()} disabled={importing}><Icon name={importing ? 'refresh' : 'plus'} className={importing ? 'spin' : ''} />{importing ? '正在导入…' : '选择 CSV 文件'}</button></div><Feedback error={error} success={success} />{data.cardTransactions.length > 0 && <div className="card-transactions"><div className="subsection-heading"><h3>付款候选 <span>{data.cardTransactions.length} 笔</span></h3><p>日期与金额相近不代表匹配成功；退款及贷记不计为付款。</p></div>{data.cardTransactions.map(transaction => <div key={transaction.id} className="transaction-row"><div><strong>{transaction.description}</strong><small>{transaction.date} · {transaction.sourceFilename}</small></div><span className={`amount ${asCents(transaction.amount) < 0n ? 'warning-text' : ''}`}>{money(transaction.amount, transaction.currency)}{asCents(transaction.amount) < 0n && <small className="cell-sub">退款 / 贷记</small>}</span><div className="candidate-actions">{transaction.candidateRecordIDs.length ? transaction.candidateRecordIDs.map(id => <button key={id} className="button secondary small" onClick={() => onSelect(id)}>{data.records.find(record => record.id === id)?.billingMonth || '候选记录'} · 待核对<Icon name="chevron" size={14} /></button>) : <span className="small-muted">暂无匹配候选</span>}</div></div>)}</div>}</section><section className="panel material-library"><div className="section-heading"><div><h2>已留存的材料</h2><p>包括原始凭证、网页采集记录和生成文档；打开时校验文件完整性。</p></div><span className="subtle-label">{allMaterials.length} 份</span></div><div className="material-grid">{allMaterials.map(material => <MaterialLink key={material.id} material={material} />)}</div>{!allMaterials.length && <Empty title="尚无订阅原件">导入的原始凭证会在这里展示。</Empty>}<div className="import-footnote"><Icon name="info" size={15} /><span>历史导入：{timeLabel(data.importSummary.importedAt)} · 共保留 {data.importSummary.materials} 份材料。ARP 审批原件请在“ARP 对账”中查看。</span></div></section></>;
}
