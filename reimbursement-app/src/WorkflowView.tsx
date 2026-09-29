import {purchaseTypeLabel} from './purchase-type';
import {api,apiAddress} from './api';
import VendorBadge,{vendorLabel} from './VendorBadge';
import ScreenshotInboxButton from './ScreenshotInbox';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import { useEffect, useState, type ReactNode } from 'react';
import BatchEditor from './BatchEditor';
import BatchZipAction from './BatchZipAction';
import ActionButton from './ActionButton';
import {activeBatches,preparingBatches,batchAmounts,batchTitle,batchStage,canSelectForBatch,lockedForBatch,type BatchStage} from './claim-batches';
import {listBatchDrafts,type BatchLocalDraft} from './batch-local-draft';
import type { DeliveryStatus, Material, RecordItem, Workspace } from './types';
import { applicationDocuments, arePriorStepsComplete, cny, deliveryFiles, getExchangeRateEvidence, getRecordWorkflow, isFinanceCompleted, sortWorkflowRecords, sourceFreshness, validMaterials, type DeliveryFile, type WorkflowStepId } from './workflow';
import './workflow.css';
import {recordSourceCurrent} from './vendors';
import {mobileNextAction, matchesProgress, progressFilters, type ProgressFilter} from './workflow-next-action';

type Props = { data: Workspace; onOpenRecord: (id: string, step: WorkflowStepId) => void; onOpenMaterials: () => void; onOpenARP: () => void; onReload: () => Promise<unknown> };
type CellModel = { done: boolean; title: string; detail: string; link?: { material: Material; label: string } };
type MergeEntry = {key:string;stage:BatchStage;record:RecordItem;batch?:never;status?:never}|{key:string;stage:BatchStage;batch:NonNullable<Workspace['claimBatches']>[number];status:ReturnType<typeof batchStage>;record?:never};
const columns: { id: WorkflowStepId; title: string }[] = [{ id: 'materials', title: '发票准备' }, { id: 'payment', title: '实付款' }, { id: 'claim', title: '申报材料' }, { id: 'submission', title: '交财务' }, { id: 'approval', title: '财务审核' }];
const mergeStages = ['未达合并条件', '可选择合并', '准备合并材料', '材料确认，可下载 ZIP', '材料已提交', '财务审批完全通过'] as const;
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
  if (id === 'materials') return record.invoiceRecipient && !record.invoiceRecipient.valid ? { done: false, title: '抬头待复核', detail: '核对发票抬头与原件', ...(invoices[0] ? { link: { material: invoices[0], label: '查看发票' } } : {}) } : invoices.length ? { done: sourceCurrent, title: sourceCurrent ? '已收集' : '待更新采集', detail: record.invoiceRecipient?.requiresSignedSupplement ? '抬头非 IHEP；第三阶段补签字说明' : `${invoices.length} 份发票原件`, link: { material: invoices[0], label: '查看发票' } } : { done: false, title: '缺发票', detail: '原件尚未收集' };
  if (id === 'payment') return payments.length ? { done: true, title: '凭证已收集', detail: record.paymentVerified ? (record.aiReview?.status==='matched'?'AI 核验通过':'付款事实已核实') : record.aiReview?.status==='running'||record.aiReview?.status==='queued'?'AI 核验中':record.aiReview?.status==='mismatch'?'AI 发现字段不符':record.aiReview?.status==='failed'?'AI 核验失败，待处理':'付款事实待核对', link: { material: payments[0], label: '查看付款凭证' } } : { done: false, title: '缺付款凭证', detail: '补充截图或 PDF' };
  if (id === 'claim') {
    if (submissionPDF) return { done: true, title: '已备妥', detail: record.currency === 'CNY' ? '原件与情况说明完整' : '当日汇率已留证', link: { material: submissionPDF, label: '报销说明 PDF' } };
    if (record.invoiceRecipient?.requiresSignedSupplement) return { done: false, title: '待签字说明', detail: '每份申报材料一份，随用途说明准备' };
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
  const [mergeFilter,setMergeFilter]=useState<BatchStage|'all'>('all');
  const [editor,setEditor]=useState<{recordIDs:string[];batchID?:string;initialSection?:'supplement'}|null>(null);
  const [localDrafts,setLocalDrafts]=useState<BatchLocalDraft[]>([]);
  useEffect(()=>{const read=()=>{try{setLocalDrafts(listBatchDrafts(localStorage,apiAddress()));}catch{setLocalDrafts([]);}};read();window.addEventListener('storage',read);window.addEventListener('reimbursement-batch-draft',read);return()=>{window.removeEventListener('storage',read);window.removeEventListener('reimbursement-batch-draft',read);};},[]);
  const batches=activeBatches(data),grouped=new Set(batches.flatMap(b=>b.recordIDs));
  const preparing=preparingBatches(data),preparingIDs=new Set(preparing.map(b=>b.id));
  const ungrouped=data.records.filter(record=>!grouped.has(record.id)&&!lockedForBatch(record,data));
  const eligible=ungrouped.filter(record=>canSelectForBatch(record,data));
  const notEligible=ungrouped.filter(record=>!canSelectForBatch(record,data));
  const stagedBatches=batches.map(batch=>({batch,status:batchStage(batch,data)}));
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed' | WorkflowStepId>('all');
  const [progress, setProgress] = useState<ProgressFilter>('all');
  const [search, setSearch] = useState('');
  const [freshDays, setFreshDays] = useState(() => { try { const value = Number(localStorage.getItem('reimbursement.sourceFreshDays')); return Number.isInteger(value) && value >= 1 && value <= 365 ? value : 7; } catch { return 7; } });
  const sources = data.sources.filter(source => data.records.some(record => record.vendor === source.id));
  const sorted = sortWorkflowRecords(data.records.filter(record=>!grouped.has(record.id)));
  const completed = sorted.filter(isFinanceCompleted).length;
  const query = search.trim().toLowerCase();
  const rows = sorted.map(record => {
    const cells = columns.map(column => cellModel(record, column.id, data, recordSourceCurrent(record, data, freshDays)));
    // Use the displayed completion states, including source freshness and finance overrides.
    const currentStage = columns[cells.findIndex(cell => !cell.done)]?.id;
    return { record, cells, currentStage };
  });
  const stageFilter = columns.find(column => column.id === filter);
  const visible = rows.filter(({ record, currentStage }) => (filter === 'all' || (filter === 'completed' ? isFinanceCompleted(record) : filter === 'pending' ? !isFinanceCompleted(record) : currentStage === filter)) && matchesProgress(record, data, progress) && `${record.billingMonth} ${record.date} ${record.invoiceNumber} ${record.accountName} ${record.submissionReference} ${vendorLabel(record.vendor)} ${record.plan} ${purchaseTypeLabel(record.plan)} ${record.vendor==='claude'?'anthropic':record.vendor==='chatgpt'?'openai gpt':''}`.toLowerCase().includes(query));
  const mergeEntries:MergeEntry[] = [
    ...sortWorkflowRecords(notEligible).map(record=>({key:record.id,stage:1 as BatchStage,record})),
    ...sortWorkflowRecords(eligible).map(record=>({key:record.id,stage:2 as BatchStage,record})),
    ...stagedBatches.map(({batch,status})=>({key:batch.id,stage:status.stage,batch,status})),
  ].sort((left,right)=>left.stage-right.stage);
  const visibleMergeEntries=mergeEntries.filter(entry=>mergeFilter==='all'||entry.stage===mergeFilter);
  const mergeCounts=mergeStages.map((_,index)=>mergeEntries.filter(entry=>entry.stage===index+1).length);
  const counts = columns.map((_, index) => rows.filter(row => row.cells[index].done).length);
  const stageCounts = columns.map(column => rows.filter(row => row.currentStage === column.id).length);
  function toggleStage(stage: WorkflowStepId) { setFilter(current => current === stage ? 'all' : stage); setProgress('all'); }
  function clearStage() { setFilter('all'); setProgress('all'); }
  const chosen=data.records.filter(r=>selected.includes(r.id)&&!grouped.has(r.id)&&canSelectForBatch(r,data));
  const selectedAmounts=batchAmounts(chosen);
  function changePeriod(raw: string) { const value = Number(raw); if (!Number.isInteger(value) || value < 1 || value > 365) return; setFreshDays(value); try { localStorage.setItem('reimbursement.sourceFreshDays', String(value)); } catch { /* The setting remains valid for this view. */ } }
  function renderMergeRow(entry:MergeEntry) {
    const {record,batch,status}=entry;
    const members=batch?data.records.filter(item=>batch.recordIDs.includes(item.id)):[];
    const totals=batch?batchAmounts(members):null;
    const pdf=status?.document?.materials.find(material=>material.id===status.document?.submissionPDFMaterialID);
    const next=record?mobileNextAction(record,data):null;
    return <tr key={entry.key} className={entry.stage===6?'is-complete':''}>
      <th scope="row" className="ov-merge-identity">
        {record?<><VendorBadge vendor={record.vendor} plan={record.plan}/><strong>{monthLabel(record.billingMonth)}</strong><span>{amount(record)} · {record.invoiceNumber||'发票编号待补充'}</span></>:<><strong>{batchTitle(members)}</strong><span>{members.length} 笔 · {totals?.totalCNY?`¥${totals.totalCNY}`:'人民币待核对'}</span></>}
      </th>
      {mergeStages.map((label,index)=>{
        const stage=index+1;
        if(stage<entry.stage)return <td key={label} className="ov-merge-past"><Mark done/><span>已完成</span></td>;
        if(stage>entry.stage)return <td key={label} className="ov-merge-future"><span aria-label="尚未到达">—</span></td>;
        return <td key={label} className="ov-merge-current"><strong>{status?.label||label}</strong>
          {record&&stage===1&&<small>尚未达到共同申请条件，或暂无可配对费用。</small>}
          {record&&stage===1&&next&&<button className="ov-merge-record-action" onClick={()=>onOpenRecord(record.id,next.step)}>{next.title} <span aria-hidden="true">›</span></button>}
          {record&&stage===2&&<label className="ov-merge-pick"><input type="checkbox" aria-label={`选择合并 ${record.billingMonth} ${record.invoiceNumber}`} checked={selected.includes(record.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,record.id]:ids.filter(id=>id!==record.id))}/>选择此笔</label>}
          {status&&<small>{status.detail}</small>}
          {batch&&status?.stage===3&&!members.some(item=>lockedForBatch(item,data))&&<>
            {members.some(item=>item.invoiceRecipient?.requiresSignedSupplement||item.invoiceRecipient?.recipientKind==='non_ihep')&&<button className="button primary small" onClick={()=>setEditor({recordIDs:batch.recordIDs,batchID:batch.id,initialSection:'supplement'})}>上传说明</button>}
            <button className="button secondary small" onClick={()=>setEditor({recordIDs:batch.recordIDs,batchID:batch.id})}>准备合并材料</button>
          </>}
          {pdf&&<FileLink material={pdf}>报销说明 PDF</FileLink>}
          {status?.stage===4&&status.document&&<BatchZipAction key={status.document.id} document={status.document}/>}
        </td>;
      })}
    </tr>;
  }
  function renderSingleRow({record,cells,currentStage}:typeof rows[number]) {
    return <tr key={record.id} className={isFinanceCompleted(record)?'ov-reimbursed':''}>
      <th scope="row" className="ov-identity"><VendorBadge vendor={record.vendor} plan={record.plan}/><div className="ov-identity-top"><strong title={`发票日期 ${record.date}`}>{monthLabel(record.billingMonth)}</strong><span>{amount(record)}</span></div><span className="ov-invoice" title={record.invoiceNumber}>{record.invoiceNumber||'发票编号待补充'}</span></th>
      {cells.map((cell,index)=>{
        const column=columns[index],current=currentStage===column.id;
        return <td key={column.id} className={`ov-single-stage-cell ${current?'is-current':cell.done?'is-done':'is-future'}`}>
          <div className="ov-cell"><button className="ov-cell-button" onClick={()=>onOpenRecord(record.id,column.id)} aria-label={`${monthLabel(record.billingMonth)}，${column.title}：${current?'当前待办，':cell.done?'已完成，':'尚未完成，'}${cell.title}，${cell.detail}`}><span className="ov-cell-title"><Mark done={cell.done}/><strong>{cell.title}</strong></span><span className="ov-cell-detail">{cell.detail}</span></button>{cell.link&&<div className="ov-cell-file"><FileLink material={cell.link.material}>{cell.link.label}</FileLink></div>}</div>
        </td>;
      })}
    </tr>;
  }

  return <section className="reimbursement-overview" aria-label="费用报销总览">
    <section className="ov-merge-panel" aria-label="合并报销进度"><h2>合并报销</h2><p>每行是一笔待合并费用或一组合并报销；列表示六个进度。点上方统计可只看该状态。</p>
      <div className="ov-merge-stages" role="group" aria-label="筛选合并报销状态">{mergeStages.map((label,index)=>{const stage=(index+1) as BatchStage;return <button type="button" key={label} className={mergeFilter===stage?'is-active':''} aria-pressed={mergeFilter===stage} onClick={()=>setMergeFilter(current=>current===stage?'all':stage)}><b>{index+1}</b><span>{label}</span><small>{mergeCounts[index]}{index<2?' 笔':' 组'}</small></button>;})}</div>
      {mergeFilter!=='all'&&<div className="ov-merge-filter-state" role="status">正在查看：{mergeStages[mergeFilter-1]} · {visibleMergeEntries.length}{mergeFilter<3?' 笔':' 组'} <button className="text-button" onClick={()=>setMergeFilter('all')}>显示全部</button></div>}
      <div className="ov-merge-scroll" tabIndex={0} aria-label="合并报销六阶段表格，可横向滚动"><table className="ov-merge-table"><colgroup><col className="ov-merge-identity-width"/>{mergeStages.map(label=><col key={label}/>)}</colgroup><thead><tr><th scope="col">费用 / 合并组</th>{mergeStages.map((label,index)=><th key={label} scope="col"><span>{index+1}</span>{label}</th>)}</tr></thead><tbody>{visibleMergeEntries.map(renderMergeRow)}</tbody></table>{!visibleMergeEntries.length&&<div className="ov-empty">{mergeEntries.length?'该状态暂无记录。':'暂无合并报销记录。'}</div>}</div>
      {localDrafts.filter(d=>(!batches.some(b=>b.id===d.id)||preparingIDs.has(d.id))&&d.recordIDs.length>=2&&d.recordIDs.every(id=>data.records.some(r=>r.id===id&&!lockedForBatch(r,data)))&&!data.claimBatches?.some(b=>b.recordIDs.some(id=>d.recordIDs.includes(id))&&(b.id!==d.id||b.status==='archived'))).map(d=><div className="ov-batch-toolbar" key={d.id}><span>本机暂存 · {d.recordIDs.length} 笔 · {new Date(d.savedAt).toLocaleString()}</span><button className="button secondary small" onClick={()=>setEditor({recordIDs:d.recordIDs,batchID:batches.find(b=>b.id===d.id)?.id})}>打开本机暂存</button></div>)}
      <div className="ov-batch-toolbar"><span>{chosen.length?`已选 ${chosen.length} 笔 · ${selectedAmounts.totalCNY?'¥'+selectedAmounts.totalCNY:'待补汇率'}`:'在第 2 列勾选 2–10 笔可合并费用'}</span><ActionButton className="button primary small" reason={chosen.length<2?'请先勾选至少 2 笔可合并的费用。':chosen.length>10?'一次最多合并 10 笔费用，请减少选择。':selectedAmounts.overLimit?'所选费用合计超过 ¥4,000.00，请减少选择。':''} onClick={()=>{setEditor({recordIDs:chosen.map(r=>r.id)});setSelected([]);}}>合并准备材料{chosen.length?`（${chosen.length}）`:''}</ActionButton>{chosen.length>0&&<button className="text-button" onClick={()=>setSelected([])}>取消选择</button>}</div>
    </section>
    {editor&&<BatchEditor key={editor.batchID||editor.recordIDs.join(':')} data={data} recordIDs={editor.recordIDs} initialSection={editor.initialSection} batch={batches.find(b=>b.id===editor.batchID)} onReload={onReload} onClose={()=>setEditor(null)} delivery={<DeliveryPanel data={data} onReload={onReload} recordIDs={editor.recordIDs}/>}/>}
    <section className="ov-single-section" aria-label="单笔报销">
      <div className="ov-single-heading"><h2>单笔报销</h2><span>每笔费用一行 · 浅蓝色标出当前阶段</span></div>
      <ScreenshotInboxButton data={data} onReload={onReload} onOpenRecord={onOpenRecord}/>
      <div className="ov-toolbar">
        <div className="ov-filters" role="group" aria-label="单笔费用筛选">{([['all','全部',sorted.length],['pending','待处理',sorted.length-completed],['completed','已报销',completed]] as const).map(([value,label,count])=><button key={value} className={filter===value?'is-active':''} aria-pressed={filter===value} onClick={()=>{setFilter(value);setProgress('all');}}>{label}<span>{count}</span></button>)}</div>
        <div className="ov-search-tools"><label className="ov-progress-filter"><span className="sr-only">按进度筛选</span><select aria-label="按进度筛选" value={progress} onChange={event=>{setProgress(event.target.value as ProgressFilter);setFilter('all');}}>{progressFilters.map(([value,label])=><option key={value} value={value}>{label} ({sorted.filter(record=>matchesProgress(record,data,value)).length})</option>)}</select></label><label className="ov-search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.7" cy="8.7" r="5.8" stroke="currentColor" strokeWidth="1.3"/><path d="m13 13 4.2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg><input aria-label="搜索服务、月份或账号" placeholder="搜索服务、月份或账号" value={search} onChange={event=>setSearch(event.target.value)}/></label></div>
      </div>
      <div className="ov-single-stage-filters" role="group" aria-label="按单笔当前阶段筛选">{columns.map((column,index)=><button key={column.id} type="button" className={filter===column.id?'is-active':''} aria-pressed={filter===column.id} onClick={()=>toggleStage(column.id)}><span>{column.title}</span><strong>{stageCounts[index]}</strong><small>待办 · {counts[index]}/{sorted.length} 已完成</small></button>)}</div>
      {stageFilter&&<div className="ov-stage-summary"><span role="status">当前筛选：卡在“{stageFilter.title}” · {visible.length} 笔</span><button type="button" className="text-button" onClick={clearStage}>显示全部</button></div>}
      <div className="ov-table-frame ov-single-frame"><div className="ov-table-scroll" tabIndex={0} aria-label="单笔费用与五个报销阶段，可横向滚动"><table className="ov-table ov-single-table"><colgroup><col className="ov-identity-width"/>{columns.map(column=><col key={column.id}/>)}</colgroup><thead><tr><th scope="col" className="ov-identity">费用</th>{columns.map((column,index)=><th key={column.id} scope="col"><span className="ov-column-title">{column.title}</span><span className="ov-column-meta">{counts[index]} / {sorted.length} 已完成</span></th>)}</tr></thead><tbody>{visible.map(renderSingleRow)}</tbody></table>{!visible.length&&<div className="ov-empty">{sorted.length?'没有符合条件的单笔费用，请调整筛选或搜索内容。':'当前范围没有单笔费用记录。'}</div>}</div><div className="ov-source-bar">{sources.map(source=>{const freshness=sourceFreshness(source,freshDays),current=source.status==='complete'&&freshness.fresh;return <span key={source.id} className={`ov-source-state ${current?'is-current':''}`}><span aria-hidden="true"/>{vendorLabel(source.id)} 上次采集 <time dateTime={source.checkedAt}>{timeLabel(source.checkedAt)}</time>{!current&&<em>{freshness.checkedAt&&!freshness.fresh?'已过期':'需更新来源'}</em>}</span>;})}<label>更新周期<input type="number" min={1} max={365} aria-label="原始材料更新周期天数" value={freshDays} onChange={event=>changePeriod(event.target.value)}/>天</label><span className="ov-visible-count">显示 {visible.length} / {sorted.length} 笔</span></div></div>
    </section>
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
    return <tr key={file.material.id}><td><FileLink material={file.material}>{file.material.filename}</FileLink><small>{file.material.role === 'invoiceSupplement' ? '发票抬头签字说明' : file.kind === 'invoice' ? '发票' : file.kind === 'payment' ? '付款凭证' : '报销说明 PDF'}{latest ? `，登记于 ${timeLabel(latest)}` : ''}</small></td><td>{records.filter(record => file.recordIDs.includes(record.id)).map(record => shortMonth(record.billingMonth)).join('、')}</td><td>{automatic ? <><span className="delivery-auto"><Mark done />已进入财务流程，自动完成</span><small>原登记：{deliveryLabels[file.manualStatus]}</small></> : <select aria-label={`${file.material.filename} 的交付状态`} value={selected} disabled={!!savingID} onChange={event => setDrafts(previous => ({ ...previous, [file.material.id]: event.target.value as DeliveryStatus }))}><option value="unknown">待确认</option><option value="not_submitted">未交</option><option value="submitted">已交</option></select>}</td><td>{automatic ? <span className="delivery-no-action">无需补交</span> : <ActionButton className="delivery-save" reason={savingID?'正在保存交付状态并刷新列表，请稍候。':selected===file.status&&file.items.every(item=>item.status===selected)?'交付状态没有变化，无需保存。':''} onClick={() => void save(file)}>{savingID === file.material.id ? '保存中' : '保存'}</ActionButton>}</td></tr>;
  })}</tbody></table></div>{!shown.length && <p className="delivery-empty">{files.length ? '没有待处理的交付文件。' : '当前没有可交付文件。'}</p>}</div>;
}
