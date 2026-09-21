import {api} from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import { Fragment, useState, type ReactNode } from 'react';
import BatchEditor from './BatchEditor';
import {activeBatches,batchAmounts,batchTitle,lockedForBatch} from './claim-batches';
import type { DeliveryStatus, Material, RecordItem, Workspace } from './types';
import { applicationDocuments, arePriorStepsComplete, cny, deliveryFiles, getExchangeRateEvidence, getRecordWorkflow, isFinanceCompleted, sortWorkflowRecords, sourceFreshness, validMaterials, type DeliveryFile, type WorkflowStepId } from './workflow';
import './workflow.css';

type Props = { data: Workspace; onOpenRecord: (id: string, step: WorkflowStepId) => void; onOpenMaterials: () => void; onOpenARP: () => void; onReload: () => Promise<unknown> };
type CellModel = { done: boolean; title: string; detail: string; link?: { material: Material; label: string } };
const columns: { id: WorkflowStepId; title: string }[] = [{ id: 'materials', title: '原始材料' }, { id: 'payment', title: '实付款' }, { id: 'claim', title: '申报材料' }, { id: 'submission', title: '交财务' }, { id: 'approval', title: '财务审核' }];
const deliveryLabels: Record<DeliveryStatus, string> = { unknown: '待确认', submitted: '已交', not_submitted: '未交' };
const monthLabel = (value: string) => /^\d{4}-\d{2}$/.test(value) ? `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月` : value || '月份待确认';
const shortMonth = (value: string) => /^\d{4}-\d{2}$/.test(value) ? `${Number(value.slice(5))} 月` : value;
const amount = (record: RecordItem) => `${record.currency === 'USD' ? '$' : record.currency === 'CNY' ? '¥' : `${record.currency} `}${record.amount}`;
const timeLabel = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '未记录';

function Mark({ done }: { done: boolean }) { return done ? <svg className="ov-mark ov-mark-done" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" /><path d="m4.8 8 2.1 2.1 4.3-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg> : <span className="ov-mark ov-mark-pending" aria-hidden="true"><i /></span>; }
function FileLink({ material, children }: { material: Material; children: ReactNode }) { return <AuthenticatedFileLink className={`ov-file-link ${material.integrity !== 'ok' ? 'has-issue' : ''}`} href={material.href} title={material.filename} filename={material.filename}>{children}<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M5 2H2v8h8V7M7 2h3v3M10 2 5 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>{material.integrity !== 'ok' && <span>原件异常</span>}</AuthenticatedFileLink>; }

function cellModel(record: RecordItem, id: WorkflowStepId, data: Workspace, sourceCurrent: boolean): CellModel {
  const finance = isFinanceCompleted(record);
  const invoices = validMaterials(record, 'invoice'), payments = validMaterials(record, 'payment');
  const documents = applicationDocuments(record, data);
  const submissionPDF = documents.flatMap(document => document.materials.filter(material => material.id === document.submissionPDFMaterialID))[0];
  const exchange = getExchangeRateEvidence(record, data);
  if (finance || id !== 'approval' && arePriorStepsComplete(record)) {
    const file = id === 'materials' ? invoices[0] : id === 'payment' ? payments[0] : id === 'claim' ? submissionPDF : undefined;
    return { done: true, title: id === 'approval' ? '已通过' : '已完成', detail: id === 'approval' ? `审核通过 ${cny(record.approvedCNY)}` : finance ? '财务审核已通过' : '已进入财务审核', ...(file ? { link: { material: file, label: id === 'claim' ? '报销说明 PDF' : '查看原件' } } : {}) };
  }
  if (id === 'materials') return invoices.length ? { done: sourceCurrent, title: sourceCurrent ? '已收集' : '待更新采集', detail: `${invoices.length} 份发票原件`, link: { material: invoices[0], label: '查看发票' } } : { done: false, title: '缺发票', detail: '原件尚未收集' };
  if (id === 'payment') return payments.length ? { done: true, title: '凭证已收集', detail: record.paymentVerified ? (record.aiReview?.status==='matched'?'AI 核验通过':'付款事实已核实') : record.aiReview?.status==='running'||record.aiReview?.status==='queued'?'AI 核验中':record.aiReview?.status==='mismatch'?'AI 发现字段不符':record.aiReview?.status==='failed'?'AI 核验失败，待处理':'付款事实待核对', link: { material: payments[0], label: '查看付款凭证' } } : { done: false, title: '缺付款凭证', detail: '补充截图或 PDF' };
  if (id === 'claim') {
    if (submissionPDF) return { done: true, title: '已备妥', detail: record.currency === 'CNY' ? '原件与情况说明完整' : '当日汇率已留证', link: { material: submissionPDF, label: '报销说明 PDF' } };
    const title = !payments.length || !invoices.length ? '材料未齐' : !exchange.valid ? '待补汇率截图' : '待整合申报材料';
    const missing = [!invoices.length && '发票', !payments.length && '付款', !exchange.valid && '当日汇率'].filter(Boolean).join('、');
    return { done: false, title, detail: missing ? `缺${missing}` : '缺报销说明 PDF', ...(exchange.screenshots[0] ? { link: { material: exchange.screenshots[0], label: '查看汇率截图' } } : {}) };
  }
  if (id === 'submission') {
    const files = deliveryFiles([record], data);
    const submitted = files.filter(file => file.status === 'submitted').length;
    const stage = getRecordWorkflow(record, data).find(step => step.id === id)!;
    return { done: stage.state === 'done', title: stage.state === 'done' ? '已交齐' : submitted ? '部分已交' : '交付待确认', detail: `${submitted} / ${files.length} 份现有文件已交` };
  }
  const arp = data.arpRecords.find(item => item.reimbursementNumber === record.submissionReference);
  return { done: false, title: record.financeReviewPending ? '审核中' : record.submissionReference ? '进度待核对' : '待提交', detail: record.financeReviewPending ? `待审核 ${cny(record.claimedCNY)}` : record.claimConfirmed ? `尚差 ${cny(record.outstandingCNY)}` : '申报金额未确认', ...(arp?.materialIds[0] && data.materials?.find(material => material.id === arp.materialIds[0]) ? { link: { material: data.materials.find(material => material.id === arp.materialIds[0])!, label: '查看 ARP 记录' } } : {}) };
}

export default function WorkflowView({ data, onOpenRecord, onReload }: Props) {
  const [selected,setSelected]=useState<string[]>([]);
  const [expanded,setExpanded]=useState<string[]>([]);
  const [editor,setEditor]=useState<{recordIDs:string[];batchID?:string}|null>(null);
  const batches=activeBatches(data),grouped=new Set(batches.flatMap(b=>b.recordIDs));
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [freshDays, setFreshDays] = useState(() => { try { const value = Number(localStorage.getItem('reimbursement.sourceFreshDays')); return Number.isInteger(value) && value >= 1 && value <= 365 ? value : 7; } catch { return 7; } });
  const source = data.sources.find(item => item.id === 'chatgpt');
  const freshness = sourceFreshness(source, freshDays);
  const sourceCurrent = source?.status === 'complete' && freshness.fresh;
  const sorted = sortWorkflowRecords(data.records);
  const completed = sorted.filter(isFinanceCompleted).length;
  const query = search.trim().toLowerCase();
  const rows = sorted.map(record => ({ record, cells: columns.map(column => cellModel(record, column.id, data, sourceCurrent)) }));
  const visible = rows.filter(({ record }) => (filter === 'all' || (filter === 'completed' ? isFinanceCompleted(record) : !isFinanceCompleted(record))) && `${record.billingMonth} ${record.date} ${record.invoiceNumber} ${record.accountName} ${record.submissionReference}`.toLowerCase().includes(query));
  const counts = columns.map((_, index) => rows.filter(row => row.cells[index].done).length);
  const chosen=data.records.filter(r=>selected.includes(r.id)&&!grouped.has(r.id)&&!lockedForBatch(r,data));
  const selectedAmounts=batchAmounts(chosen);
  function renderRow({record,cells}:typeof rows[number]) {return <tr key={record.id} className={isFinanceCompleted(record)?'ov-reimbursed':''}>
    <th scope="row" className="ov-identity"><div className="ov-identity-top">{!grouped.has(record.id)&&!lockedForBatch(record,data)&&<input className="ov-batch-select" type="checkbox" aria-label={'选择合并 '+record.billingMonth+' '+record.invoiceNumber} checked={selected.includes(record.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,record.id]:ids.filter(id=>id!==record.id))}/>}<strong title={`发票日期 ${record.date}`}>{monthLabel(record.billingMonth)}</strong><span>{amount(record)}</span></div><span className="ov-invoice" title={record.invoiceNumber}>{record.invoiceNumber||'发票编号待补充'}</span></th>
    {cells.map((cell,index)=><td key={columns[index].id} onClick={event=>{if(!(event.target as Element).closest('button, a'))onOpenRecord(record.id,columns[index].id);}}><div className="ov-cell"><button className={`ov-cell-button ${cell.done?'is-done':'is-pending'}`} onClick={()=>onOpenRecord(record.id,columns[index].id)} aria-label={`${monthLabel(record.billingMonth)}，${columns[index].title}：${cell.title}，${cell.detail}`}><span className="ov-cell-title"><Mark done={cell.done}/><strong>{cell.title}</strong></span><span className="ov-cell-detail">{cell.detail}</span></button>{cell.link&&<div className="ov-cell-file"><FileLink material={cell.link.material}>{cell.link.label}</FileLink></div>}</div></td>)}
  </tr>;}
  function changePeriod(raw: string) { const value = Number(raw); if (!Number.isInteger(value) || value < 1 || value > 365) return; setFreshDays(value); try { localStorage.setItem('reimbursement.sourceFreshDays', String(value)); } catch { /* The setting remains valid for this view. */ } }

  return <section className="reimbursement-overview" aria-label="费用报销总览">
    <div className="ov-batch-toolbar"><span>{chosen.length?`已选 ${chosen.length} 笔 · ${selectedAmounts.totalCNY?'¥'+selectedAmounts.totalCNY:'待补汇率'}`:'勾选费用，可将两笔合并成一份说明和 PDF'}</span><button className="button primary small" disabled={chosen.length<2||chosen.length>10} onClick={()=>{setEditor({recordIDs:chosen.map(r=>r.id)});setSelected([]);}}>合并准备材料{chosen.length?`（${chosen.length}）`:''}</button>{chosen.length>0&&<button className="text-button" onClick={()=>setSelected([])}>取消选择</button>}</div>
    {editor&&<BatchEditor key={editor.batchID||editor.recordIDs.join(':')} data={data} recordIDs={editor.recordIDs} batch={batches.find(b=>b.id===editor.batchID)} onReload={onReload} onClose={()=>setEditor(null)} delivery={<DeliveryPanel data={data} onReload={onReload} recordIDs={editor.recordIDs}/>}/>}
    <div className="ov-toolbar"><div className="ov-filters" role="group" aria-label="费用筛选">{([['all', '全部', sorted.length], ['pending', '待处理', sorted.length - completed], ['completed', '已报销', completed]] as const).map(([value, label, count]) => <button key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}</div><label className="ov-search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.7" cy="8.7" r="5.8" stroke="currentColor" strokeWidth="1.3" /><path d="m13 13 4.2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg><input aria-label="搜索月份、发票或账号" placeholder="搜索月份、发票或账号" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <div className="ov-table-frame"><div className="ov-table-scroll" tabIndex={0} aria-label="费用与五个报销流程，可横向滚动"><table className="ov-table"><colgroup><col className="ov-identity-width" />{columns.map(column => <col key={column.id} />)}</colgroup><thead><tr><th scope="col" className="ov-identity"><span className="ov-column-title">费用</span><span className="ov-column-meta">按发票日期排序</span></th>{columns.map((column, index) => <th key={column.id} scope="col"><span className="ov-column-count"><b>{counts[index]}</b><span>/ {sorted.length}</span></span><span className="ov-column-title">{column.title}</span></th>)}</tr></thead><tbody>{batches.filter(b=>visible.some(row=>b.recordIDs.includes(row.record.id))).map(batch=>{
      const members=data.records.filter(r=>batch.recordIDs.includes(r.id)),totals=batchAmounts(members),open=expanded.includes(batch.id)||!!query;
      const docs=(data.documents||[]).filter(d=>d.batchID===batch.id),ready=docs.find(d=>d.ready&&!d.stale),latest=ready||docs[0];
      const pdf=latest?.materials.find(m=>m.id===latest.submissionPDFMaterialID);
      return <Fragment key={batch.id}><tr className="ov-batch-row"><td colSpan={6}><div className="ov-batch-header"><button className="text-button" aria-expanded={open} onClick={()=>setExpanded(ids=>ids.includes(batch.id)?ids.filter(id=>id!==batch.id):[...ids,batch.id])}>{open?'收起':'展开'} {members.length} 笔</button><strong>GPT 合并包 · {batchTitle(members)}</strong><span>{totals.totalCNY?'¥'+totals.totalCNY:'人民币待确认'}</span><span>{members.every(isFinanceCompleted)?'已报销':ready?'材料备妥':latest?.stale?'需重新生成':'待准备材料'}</span><button className="button secondary small" onClick={()=>setEditor({recordIDs:batch.recordIDs,batchID:batch.id})}>准备合并材料</button>{pdf&&<FileLink material={pdf}>{latest?.stale?'历史 PDF':'报销说明 PDF'}</FileLink>}</div></td></tr>{open&&visible.filter(row=>batch.recordIDs.includes(row.record.id)).map(renderRow)}</Fragment>;
    })}{visible.filter(row=>!grouped.has(row.record.id)).map(renderRow)}</tbody></table>{!visible.length && <div className="ov-empty">{sorted.length ? '没有符合条件的费用，请调整筛选或搜索内容。' : '当前范围没有费用记录。'}</div>}</div><div className="ov-source-bar"><span className={`ov-source-state ${sourceCurrent ? 'is-current' : ''}`}><span aria-hidden="true" />原始材料上次采集 <time dateTime={source?.checkedAt}>{timeLabel(source?.checkedAt)}</time>{!sourceCurrent && <em>{freshness.checkedAt && !freshness.fresh ? '已过期' : '需更新来源'}</em>}</span><label>更新周期<input type="number" min={1} max={365} aria-label="原始材料更新周期天数" value={freshDays} onChange={event => changePeriod(event.target.value)} />天</label><span className="ov-visible-count">显示 {visible.length} / {sorted.length} 笔</span></div></div>
  </section>;
}

export function DeliveryPanel({ data, onReload, recordID, recordIDs }: { data: Workspace; onReload: () => Promise<unknown>; recordID?: string; recordIDs?: string[] }) {
  const [pendingOnly, setPendingOnly] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DeliveryStatus>>({});
  const [savingID, setSavingID] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const records = recordIDs ? data.records.filter(record => recordIDs.includes(record.id)) : recordID ? data.records.filter(record => record.id === recordID) : data.records;
  const files = deliveryFiles(records, data);
  const delivered = files.filter(file => file.status === 'submitted' && (file.derivedByFinance || file.material.integrity === 'ok')).length;
  const shown = files.filter(file => !pendingOnly || file.status !== 'submitted' || !file.derivedByFinance && file.material.integrity !== 'ok');
  const missingPackages = records.filter(record => !arePriorStepsComplete(record) && !applicationDocuments(record, data).length).length;
  async function save(file: DeliveryFile) {
    const status = drafts[file.material.id] ?? file.status;
    setSavingID(file.material.id); setMessage(''); setError(''); let saved = 0;
    try {
      for (const item of file.items) {
        if (item.status === status || file.financeRecordIDs.includes(item.recordID)) continue;
        await api(`/api/records/${encodeURIComponent(item.recordID)}/delivery`, { method: 'POST', body: JSON.stringify({ materialID: item.materialID, status, baseVersion: item.version }) });
        saved++;
      }
      setDrafts(previous => { const next = { ...previous }; delete next[file.material.id]; return next; });
      setMessage(`已保存：${file.material.filename}，${deliveryLabels[status]}`);
    } catch (err) { setError(`${saved ? `已保存 ${saved} 笔关联，余下未保存。` : ''}${err instanceof Error ? err.message : '保存失败，请刷新后重试。'}`); }
    finally { try { await onReload(); } catch { setError(previous => `${previous ? `${previous} ` : ''}刷新失败，请重新载入后检查保存结果。`); } setSavingID(''); }
  }
  return <div className="delivery-panel"><div className="delivery-summary"><strong>{delivered} / {files.length} 份已交</strong><label><input type="checkbox" checked={pendingOnly} onChange={event => setPendingOnly(event.target.checked)} />只看待办</label></div>{missingPackages > 0 && <p className="delivery-note">另有 {missingPackages} 笔申报材料未齐，Word 编辑源不计必交。</p>}{message && <p className="delivery-feedback" role="status">{message}</p>}{error && <p className="delivery-feedback is-error" role="alert">{error}</p>}<div className="delivery-table-scroll"><table className="delivery-table"><thead><tr><th>交付文件</th><th>月份</th><th>交财务状态</th><th><span className="sr-only">保存</span></th></tr></thead><tbody>{shown.map(file => {
    const selected = drafts[file.material.id] ?? file.status;
    const automatic = file.derivedByFinance && file.status === 'submitted';
    const latest = file.items.map(item => item.updatedAt).filter((value): value is string => !!value).sort().at(-1);
    return <tr key={file.material.id}><td><FileLink material={file.material}>{file.material.filename}</FileLink><small>{file.kind === 'invoice' ? '发票' : file.kind === 'payment' ? '付款凭证' : '报销说明 PDF'}{latest ? `，登记于 ${timeLabel(latest)}` : ''}</small></td><td>{records.filter(record => file.recordIDs.includes(record.id)).map(record => shortMonth(record.billingMonth)).join('、')}</td><td>{automatic ? <><span className="delivery-auto"><Mark done />已进入财务流程，自动完成</span><small>原登记：{deliveryLabels[file.manualStatus]}</small></> : <select aria-label={`${file.material.filename} 的交付状态`} value={selected} disabled={!!savingID} onChange={event => setDrafts(previous => ({ ...previous, [file.material.id]: event.target.value as DeliveryStatus }))}><option value="unknown">待确认</option><option value="not_submitted">未交</option><option value="submitted">已交</option></select>}</td><td>{automatic ? <span className="delivery-no-action">无需补交</span> : <button className="delivery-save" disabled={!!savingID || selected === file.status && file.items.every(item => item.status === selected)} onClick={() => void save(file)}>{savingID === file.material.id ? '保存中' : '保存'}</button>}</td></tr>;
  })}</tbody></table></div>{!shown.length && <p className="delivery-empty">{files.length ? '没有待处理的交付文件。' : '当前没有可交付文件。'}</p>}</div>;
}
