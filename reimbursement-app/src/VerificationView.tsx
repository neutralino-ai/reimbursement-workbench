import { useEffect, useState } from 'react';
import type { Material, RecordItem, Workspace } from './types';
import { api } from './api';
import { isFinanceCompleted } from './workflow';
import './verification.css';

type HumanReview = { status: 'unreviewed' | 'verified' | 'stale' | 'rejected'; reviewedVersion: string | null; note: string; at: string | null };
type ReviewRecord = RecordItem & { version?: string; evidenceFingerprint?: string; lastModified?: { at: string; actor: { type: string; id: string } } | null; humanVerification?: HumanReview };
type GeneratedDocument = { id: string; title: string; status: 'draft' | 'ready'; note: string; sourceRecords: { id: string; version: string }[]; registeredAt: string; stale: boolean; materials: Material[] };
type Task = { month?: string; id: string; recordID?: string; kind: string; status: string; detail: string };
type Props = { data: Workspace; onReload: () => Promise<Workspace>; onSelect: (id: string) => void };
const reviewLabel = { unreviewed: '尚未核验', verified: '已核验', stale: '核验后有更新', rejected: '需要纠正' };
const roleLabel: Record<string, string> = { invoice: '发票', payment: '付款凭证', receipt: '收据', approval: '审批证据', observation: '采集记录', document: '生成文档', other: '补充材料' };
const money = (value: string | null | undefined, currency = 'CNY') => value ? `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `}${value}` : '待确认';
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无时间记录';

export default function VerificationView({ data, onReload, onSelect }: Props) {
  const records = data.records as ReviewRecord[];
  const documents = (data as Workspace & { documents?: GeneratedDocument[] }).documents || [];
  const [filter, setFilter] = useState<'pending' | 'all' | 'verified'>('pending');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState('');
  const [showAllTasks, setShowAllTasks] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ tasks: Task[] }>('/api/tasks').then(result => { if (active) { setTasks(result.tasks); setTaskError(''); } }).catch(error => { if (active) setTaskError(error instanceof Error ? error.message : '待办读取失败'); });
    return () => { active = false; };
  }, [data]);
  const reviewComplete = (record: ReviewRecord) => isFinanceCompleted(record) || record.humanVerification?.status === 'verified';
  const verifiedCount = records.filter(reviewComplete).length;
  const staleCount = records.filter(record => !isFinanceCompleted(record) && record.humanVerification?.status === 'stale').length;
  const filtered = records.filter(record => filter === 'all' || reviewComplete(record) === (filter === 'verified'));
  const gaps = tasks.filter(task => task.kind !== 'human_verification');

  return <div className="verification-view">
    <section className="verification-intro panel" aria-label="核验概览">
      <div><h2>核验记录</h2><p>财务已通过的记录自动完成，其余记录可在此核对原件与整理结果。</p></div>
      <div className="verification-stats"><span><strong>{records.length - verifiedCount}</strong>待核验</span><span><strong>{verifiedCount}</strong>已完成</span><span><strong>{staleCount}</strong>核验后更新</span></div>
    </section>

    <section className="verification-records" aria-labelledby="verification-records-title">
      <div className="section-heading verification-section-heading"><h2 id="verification-records-title">账单核验 <small>{records.length} 笔</small></h2><div className="segmented" aria-label="筛选核验记录">{([['pending', '待核验'], ['verified', '已完成'], ['all', '全部']] as const).map(([value, label]) => <button key={value} type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
      <div className="verification-record-list">{filtered.map(record => <RecordReview key={record.id} record={record} expanded={expanded === record.id} onExpand={() => setExpanded(expanded === record.id ? null : record.id)} onReload={onReload} onSelect={onSelect} />)}</div>
      {!filtered.length && <div className="panel verification-empty">{records.length ? '当前筛选下没有账单。' : '还没有账单。收集发票并导入后，就可以在这里核验。'}</div>}
    </section>

    <div className="verification-bottom-grid">
      <section className="panel verification-documents" aria-labelledby="verification-documents-title"><div className="section-heading"><h2 id="verification-documents-title">报销文档 <small>{documents.length} 份</small></h2></div><p className="verification-subtitle">Word 用于修改，PDF 用于查看和提交；每份文档保留对应的来源。</p>
        {!documents.length && <p className="verification-empty">尚未登记生成文档。整理完成后，Word 与 PDF 会显示在这里。</p>}
        {documents.map(document => <article className="verification-document" key={document.id}><div className="verification-document-title"><h3>{document.title}</h3><span className={`verification-badge ${document.stale ? 'stale' : document.status === 'ready' ? 'verified' : 'unreviewed'}`}>{document.stale ? '来源已更新' : document.status === 'ready' ? '已备齐' : '草稿'}</span></div><p>{document.note}</p>{document.stale && <p className="verification-warning">来源已变化，请更新文档后再使用。</p>}<div className="verification-files">{document.materials.map(material => <EvidenceLink key={material.id} material={material} />)}</div><div className="verification-document-records">{document.sourceRecords.map(source => <button className="text-button" type="button" key={source.id} onClick={() => onSelect(source.id)}>{records.find(record => record.id === source.id)?.billingMonth || '关联账单'} · 查看来源</button>)}</div><small>登记于 {dateTime(document.registeredAt)}</small></article>)}
      </section>
      <section className="panel verification-gaps" aria-labelledby="verification-gaps-title"><div className="section-heading"><h2 id="verification-gaps-title">仍需补齐 <small>{gaps.length} 项</small></h2></div><p className="verification-subtitle">显示目前缺少的证据和未完成的登记，不推定未付款或未提交。</p>
        {taskError && <p className="feedback error" role="alert">待办读取失败：{taskError}</p>}
        {!taskError && !gaps.length && <p className="verification-empty">暂未发现待补事项，请继续核对材料与月份覆盖。</p>}
        <ul className="verification-task-list">{(showAllTasks ? gaps : gaps.slice(0, 8)).map(task => <li key={task.id}><div><span>{task.recordID ? records.find(record => record.id === task.recordID)?.billingMonth || '账单事项' : task.kind === 'coverage' ? `月份覆盖 ${task.month || ''}` : '材料与来源'}</span><p>{task.detail}</p></div>{task.recordID && <button className="text-button" type="button" onClick={() => onSelect(task.recordID!)}>查看</button>}</li>)}</ul>
        {gaps.length > 8 && <button type="button" className="text-button" onClick={() => setShowAllTasks(!showAllTasks)}>{showAllTasks ? '收起待办' : `查看全部 ${gaps.length} 项`}</button>}
      </section>
    </div>
  </div>;
}

function EvidenceLink({ material }: { material: Material }) {
  return material.integrity === 'ok' ? <a className="verification-file" href={material.href} target="_blank" rel="noreferrer"><span>{roleLabel[material.role] || '材料'}</span><strong>{material.filename}</strong><small>{['observation','document'].includes(material.role) ? '打开文件' : '打开原件'} ↗</small></a> : <div className="verification-file verification-file-invalid"><span>{roleLabel[material.role] || '材料'}</span><strong>{material.filename}</strong><small>{material.integrity === 'missing' ? '原件缺失' : '原件已变更'}，请重新检查</small></div>;
}

function RecordReview({ record, expanded, onExpand, onReload, onSelect }: { record: ReviewRecord; expanded: boolean; onExpand: () => void; onReload: () => Promise<Workspace>; onSelect: (id: string) => void }) {
  const [note, setNote] = useState('');
  const [reviewVersion, setReviewVersion] = useState(record.version);
  const [reviewFingerprint, setReviewFingerprint] = useState(record.evidenceFingerprint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const status = record.humanVerification?.status || 'unreviewed';
  const financeCompleted = isFinanceCompleted(record);
  const changedDuringReview = expanded && (reviewVersion !== record.version || reviewFingerprint !== record.evidenceFingerprint);
  const expandableID = `verify-record-${record.id}`;
  function toggle() {
    if (!expanded) { setReviewVersion(record.version); setReviewFingerprint(record.evidenceFingerprint); setError(''); setSuccess(''); }
    onExpand();
  }
  async function save(result: 'accepted' | 'rejected') {
    if (!record.version || !reviewFingerprint || !note.trim() || changedDuringReview || busy) return;
    setBusy(true); setError(''); setSuccess('');
    let saved = false;
    try {
      await api(`/api/records/${encodeURIComponent(record.id)}/verify`, { method: 'POST', body: JSON.stringify({ baseVersion: reviewVersion, evidenceFingerprint: reviewFingerprint, result, note: note.trim() }) });
      saved = true;
      await onReload();
      setNote('');
      setSuccess(result === 'accepted' ? '已保存对此版本的核验。' : '已标记需要纠正，并保留你的说明。');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '保存失败，请重试。';
      setError(saved ? `核验已保存，但列表刷新失败。请刷新工作台查看：${message}` : /版本|证据/.test(message) ? `记录或证据已经更新，本次核验未保存。请刷新并重新核对：${message}` : message);
    } finally { setBusy(false); }
  }
  return <article className={`panel verification-record ${expanded ? 'expanded' : ''}`}>
    <div className="verification-record-summary"><button className="verification-expand" type="button" onClick={toggle} disabled={busy} aria-expanded={expanded} aria-controls={expandableID}><span className="verification-month">{record.billingMonth}</span><span><strong>{record.accountName} · {record.plan || '订阅'}</strong><small>{record.invoiceNumber}</small></span><span className="verification-record-amount">{money(record.amount, record.currency)}</span><span className="verification-expand-icon" aria-hidden="true">{expanded ? '−' : '+'}</span></button><span className={`verification-badge ${financeCompleted ? 'verified' : status}`}>{financeCompleted ? '财务已通过' : reviewLabel[status]}</span></div>
    <dl className="verification-facts"><div><dt>付款事实</dt><dd>{financeCompleted ? '自动完成' : record.paymentVerified ? '已核实' : '待核实'}</dd></div><div><dt>人民币申报</dt><dd>{money(record.claimedCNY)}<small>{record.claimConfirmed ? '口径已确认' : '口径待确认'}</small></dd></div><div><dt>ARP 提交</dt><dd>{record.submissionReference || (record.submittedOn ? record.submittedOn : financeCompleted ? '财务已通过' : '未登记')}<small>{record.submissionReference && record.submittedOn}</small></dd></div><div><dt>已关联审批</dt><dd>{money(record.approvedCNY)}<small>{financeCompleted ? '已报销' : '继续核对审批'}</small></dd></div></dl>
    {expanded && <div id={expandableID} className="verification-record-detail">
      <div className="verification-detail-heading"><h3>证据与整理说明</h3><button type="button" className="text-button" disabled={busy} onClick={() => onSelect(record.id)}>维护账单详情 →</button></div>
      {record.notes && <p className="verification-record-note">{record.notes}</p>}
      <div className="verification-files">{record.materials.map(material => <EvidenceLink key={material.id} material={material} />)}</div>{!financeCompleted && !record.materials.length && <p className="verification-warning">这笔账单还没有原始材料。</p>}
      <p className="verification-provenance">{record.lastModified ? `${record.lastModified.actor.type === 'agent' ? '由助手整理' : '由用户维护'} · ${dateTime(record.lastModified.at)}` : financeCompleted ? '财务已通过，自动完成' : '来自历史台账 · 请核对原始凭证'}</p>
      {record.humanVerification?.at && <div className="verification-previous"><strong>上次核验 · {dateTime(record.humanVerification.at)}</strong><p>{record.humanVerification.note}</p></div>}
      {changedDuringReview && <div className="verification-changed" role="alert"><p>记录或证据在本次核验期间发生了变化。请重新查看上方内容，再确认当前记录。</p><button className="button secondary" type="button" onClick={() => { setReviewVersion(record.version); setReviewFingerprint(record.evidenceFingerprint); setNote(''); setError(''); setSuccess(''); }}>开始核验更新后的内容</button></div>}
      <label className="verification-note-label" htmlFor={`verification-note-${record.id}`}>{financeCompleted ? '补充意见（可选）' : '核验说明'}<textarea id={`verification-note-${record.id}`} value={note} onChange={event => setNote(event.target.value)} disabled={busy || changedDuringReview} rows={3} placeholder="写下已核对的材料，或需要纠正的具体问题。" /></label>
      {error && <p className="feedback error" role="alert">{error}</p>}{success && <p className="feedback success" role="status">{success}</p>}
      <div className="verification-actions"><p>{financeCompleted ? '财务已通过，无需重复核验。' : '保存对此版本的核验意见。'}</p><button type="button" className="button secondary" disabled={busy || !note.trim() || !record.version || !reviewFingerprint || changedDuringReview} onClick={() => void save('rejected')}>需要纠正</button><button type="button" className="button primary" disabled={busy || !note.trim() || !record.version || !reviewFingerprint || changedDuringReview} onClick={() => void save('accepted')}>{busy ? '正在保存…' : '确认此版本'}</button></div>
    </div>}
  </article>;
}
