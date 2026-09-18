import {useState, type FormEvent} from 'react';
import {api} from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import type {Policy, Workspace} from './types';
import './policy.css';

const statusLabel = {active: '当前依据', reference: '待核对', superseded: '历史版本'};
const pageLabel = (clause: Policy['clauses'][number]) => `PDF 第 ${clause.pdfPage} 页${clause.printedPage ? ` · 原文 ${clause.printedPage}` : ''}`;
const originalURL = (policy: Policy) => policy.material?.href || `/api/materials/${encodeURIComponent(policy.materialID)}`;

export function PolicyReferences({data}: {data: Workspace}) {
  const policies = (data.policies || []).filter(policy => policy.status === 'active');
  if (!policies.length) return null;
  return <div className="policy-references"><h3>规则依据</h3>{policies.map(policy => <details key={policy.id}>
    <summary>{policy.title}<span>{policy.versionLabel}</span></summary>
    {policy.integrity !== 'ok' && <p className="feedback error">制度原件异常，请重新核对来源。</p>}
    {policy.note && <p>{policy.note}</p>}
    {policy.clauses.map(clause => <div className="policy-reference-clause" key={clause.id}><strong>{clause.topic}</strong><p>{clause.interpretation}</p><small>适用范围：{clause.scope}</small><AuthenticatedFileLink className="text-button" href={`${originalURL(policy)}#page=${clause.pdfPage}`} filename={policy.material?.filename || `${policy.title}.pdf`}>{clause.section} · {pageLabel(clause)}</AuthenticatedFileLink></div>)}
    <AuthenticatedFileLink className="text-button" href={originalURL(policy)} filename={policy.material?.filename || `${policy.title}.pdf`}>查看制度原件</AuthenticatedFileLink>
  </details>)}</div>;
}

export default function PolicyLibrary({data, onReload}: {data: Workspace; onReload: () => Promise<Workspace>}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  return <section className="policy-library">
    <div className="section-heading"><div><h3>制度原件与条款</h3><p>原始 PDF 单独保存。引用记录保留页码、适用范围和解读。</p></div><button className="button primary" onClick={() => setUploadOpen(value => !value)}>{uploadOpen ? '收起上传' : '上传制度 PDF'}</button></div>
    {uploadOpen && <PolicyUpload onReload={onReload} />}
    {(data.policies || []).map(policy => <PolicyCard key={`${policy.id}-${policy.version}`} policy={policy} onReload={onReload} />)}
    {!data.policies?.length && <div className="empty-state"><h3>尚未保存规则依据</h3><p>上传制度原件后，由 Agent 提取条款，用户核对。</p></div>}
  </section>;
}

function PolicyUpload({onReload}: {onReload: () => Promise<Workspace>}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [operationID, setOperationID] = useState(() => crypto.randomUUID());
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('');
    if (!file || !/\.pdf$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) { setError('请选择 20 MB 以内的 PDF 原件。'); return; }
    setBusy(true); let saved = false;
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('文件读取失败。')); reader.readAsDataURL(file);
      });
      await api('/api/policies/upload', {method: 'POST', body: JSON.stringify({filename: file.name, contentBase64, title, versionLabel, note, operationId: operationID})});
      saved = true; await onReload(); setMessage('原件已保存。条款与适用范围核对后，可设为当前依据。'); setOperationID(crypto.randomUUID());
    } catch (failure) { setError(saved ? '原件已保存，刷新失败。请刷新台账后查看。' : failure instanceof Error ? failure.message : '上传失败。'); }
    finally { setBusy(false); }
  }
  function changed() { setOperationID(crypto.randomUUID()); setError(''); setMessage(''); }
  return <form className="policy-form" onSubmit={upload}><fieldset disabled={busy}>
    <label className="field-label">制度原件<input required type="file" accept=".pdf,application/pdf" onChange={event => {const selected = event.target.files?.[0] || null; setFile(selected); if (selected) setTitle(selected.name.replace(/\.pdf$/i, '')); changed();}} /></label>
    <div className="form-row"><label className="field-label">文件名称<input required value={title} onChange={event => {setTitle(event.target.value); changed();}} /></label><label className="field-label">版本标识<input required value={versionLabel} placeholder="例如：2025-09 汇编" onChange={event => {setVersionLabel(event.target.value); changed();}} /></label></div>
    <label className="field-label">来源或适用范围<textarea rows={2} value={note} onChange={event => {setNote(event.target.value); changed();}} /></label><button className="button primary" type="submit">{busy ? '保存中…' : '保存原件'}</button>
    </fieldset>{error && <p className="feedback error" role="alert">{error}</p>}{message && <p className="feedback success" role="status">{message}</p>}
  </form>;
}

function PolicyCard({policy, onReload}: {policy: Policy; onReload: () => Promise<Workspace>}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(policy.title);
  const [versionLabel, setVersionLabel] = useState(policy.versionLabel);
  const [note, setNote] = useState(policy.note);
  const [status, setStatus] = useState(policy.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operationID, setOperationID] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); let saved = false;
    try {
      await api(`/api/policies/${encodeURIComponent(policy.id)}`, {method: 'POST', body: JSON.stringify({title, versionLabel, materialID: policy.materialID, status, note, clauses: policy.clauses, baseVersion: policy.version, operationId: operationID})});
      saved = true; await onReload(); setEditing(false);
    } catch (failure) { setError(saved ? '已保存，请刷新查看。' : failure instanceof Error ? failure.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  function changed() { setOperationID(crypto.randomUUID()); setError(''); }
  return <article className="policy-card">
    <div className="policy-card-heading"><div className="policy-file-mark">PDF</div><div className="policy-card-title"><h3>{policy.title}</h3><p>{policy.versionLabel} · {policy.material?.filename || '原件缺失'}</p></div><span className={`badge ${policy.status === 'active' ? 'status-ready' : policy.status === 'reference' ? 'status-needs_review' : ''}`}>{statusLabel[policy.status]}</span></div>
    {policy.note && <p className="policy-note">{policy.note}</p>}
    <div className="policy-file-actions"><AuthenticatedFileLink className="button secondary small" href={originalURL(policy)} filename={policy.material?.filename || `${policy.title}.pdf`}>查看原件</AuthenticatedFileLink><AuthenticatedFileLink className="button secondary small" href={originalURL(policy)} download filename={policy.material?.filename || `${policy.title}.pdf`}>下载 PDF</AuthenticatedFileLink><button className="text-button" onClick={() => setEditing(value => !value)} disabled={busy}>{editing ? '收起维护' : '维护版本与状态'}</button><small className={policy.integrity === 'ok' ? 'small-muted' : 'warning-text'}>{policy.integrity === 'ok' ? '原件校验通过' : '原件异常'}</small></div>
    {editing && <form className="policy-form" onSubmit={save}><fieldset disabled={busy}>
      <div className="form-row"><label className="field-label">文件名称<input required value={title} onChange={event => {setTitle(event.target.value); changed();}} /></label><label className="field-label">版本标识<input required value={versionLabel} onChange={event => {setVersionLabel(event.target.value); changed();}} /></label></div>
      <label className="field-label">依据状态<select value={status} onChange={event => {setStatus(event.target.value as Policy['status']); changed();}}><option value="active">当前依据</option><option value="reference">待核对</option><option value="superseded">历史版本</option></select></label>
      <label className="field-label">来源或适用范围<textarea rows={3} value={note} onChange={event => {setNote(event.target.value); changed();}} /></label><button className="button primary" type="submit">{busy ? '保存中…' : '保存修改'}</button>
    </fieldset>{error && <p className="feedback error" role="alert">{error}</p>}</form>}
    <div className="policy-clauses">{policy.clauses.map(clause => <details key={clause.id}><summary><span>{clause.topic}</span><small>{pageLabel(clause)}</small></summary><div className="policy-clause-body"><h4>{clause.section}</h4><div className="policy-clause-label">制度原文</div><blockquote>{clause.quote}</blockquote><div className="policy-clause-label">条款解读</div><p>{clause.interpretation}</p><p className="policy-scope">适用范围：{clause.scope}</p><AuthenticatedFileLink className="text-button" href={`${originalURL(policy)}#page=${clause.pdfPage}`} filename={policy.material?.filename || `${policy.title}.pdf`}>打开原文所在页</AuthenticatedFileLink></div></details>)}{!policy.clauses.length && <p className="small-muted">尚未提取引用条款。Agent 可通过 MCP 读取原件并登记页码与解读。</p>}</div>
  </article>;
}
