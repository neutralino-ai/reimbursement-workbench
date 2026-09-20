import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {api} from './api';
import type {ClaimBatch,Workspace} from './types';
import {useAutomation} from './Automation';
import AttachmentPreview from './AttachmentPreview';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import MaterialUpload from './MaterialUpload';
import {batchAmounts,batchTitle,lockedForBatch} from './claim-batches';
import {canAdoptBatchPurpose,batchPurposeLabel} from './batch-purpose';
import './claim-batches.css';

const post=<T,>(action:string,payload:object)=>api<T>('/api/automation/'+action,{method:'POST',body:JSON.stringify({...payload,operationId:crypto.randomUUID()})});
const sameIDs=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export default function BatchEditor({data,recordIDs,batch,onReload,onClose,delivery}:{data:Workspace;recordIDs:string[];batch?:ClaimBatch;onReload:()=>Promise<unknown>;onClose:()=>void;delivery?:ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [id]=useState(batch?.id||crypto.randomUUID());
  const [saved,setSaved]=useState<ClaimBatch|undefined>(batch);
  const records=recordIDs.map(id=>data.records.find(r=>r.id===id)!).filter(Boolean);
  const evidence=[...new Map(records.flatMap(r=>r.materials.filter(m=>m.role==='purposeEvidence')).map(m=>[m.id,m])).values()];
  const [purpose,setPurpose]=useState(batch?.purpose||'');
  const [sourceIDs,setSourceIDs]=useState(batch?.sourceMaterialIDs||evidence.filter(m=>m.integrity==='ok').map(m=>m.id));
  const [baseline,setBaseline]=useState({purpose:batch?.purpose||'',sourceIDs:batch?.sourceMaterialIDs||evidence.filter(m=>m.integrity==='ok').map(m=>m.id)});
  const [busy,setBusy]=useState(false),[uploadBusy,setUploadBusy]=useState(false),[pending,setPending]=useState(false);
  const [uploadRecord,setUploadRecord]=useState(records[0]?.id||'');
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[discard,setDiscard]=useState(false),[archive,setArchive]=useState(false);
  const {state,refresh,error:loadError}=useAutomation();
  const dirty=purpose!==baseline.purpose||!sameIDs(sourceIDs,baseline.sourceIDs);
  const dirtyRef=useRef(false),busyRef=useRef(false);dirtyRef.current=dirty||pending;busyRef.current=busy||uploadBusy;
  const amounts=batchAmounts(records),locked=records.some(r=>lockedForBatch(r,data));
  const job=state?.jobs.find(j=>j.kind==='batch-packet'&&j.batchID===id);
  const purposeJob=state?.jobs.find(j=>j.kind==='batch-purpose'&&j.batchID===id);
  const [adoptedJobID,setAdoptedJobID]=useState('');
  const drafting=!!purposeJob&&['queued','running'].includes(purposeJob.status);
  const packetGenerating=!!job&&['queued','running'].includes(job.status);
  const generating=drafting||packetGenerating;
  const canDraft=!!state?.settings.configured&&!!(purpose.trim()||sourceIDs.length||records.some(r=>{const p=state?.purposes[r.id];return p?.confirmedText?.trim()||p?.draft?.trim()||p?.text?.trim();}));
  const canAdopt=canAdoptBatchPurpose(purposeJob,saved?.version,busy||uploadBusy||pending||generating||locked||dirty);
  const packetDoc=data.documents?.find(d=>d.id===job?.result?.documentID);
  const stale=job?.current===false||job?.status==='stale'||packetDoc?.stale;
  const previousJob=useRef('');
  useEffect(()=>{const key=job?.id+':'+job?.status;if(previousJob.current&&previousJob.current!==key)void onReload().catch(()=>{});previousJob.current=key;},[job?.id,job?.status,onReload]);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
  function close(){if(busyRef.current)return;if(dirtyRef.current)setDiscard(true);else onClose();}
  function remember(value:ClaimBatch){setSaved(value);setPurpose(value.purpose);setSourceIDs(value.sourceMaterialIDs);setBaseline({purpose:value.purpose,sourceIDs:value.sourceMaterialIDs});}
  async function save(){
    if(saved&&!dirty)return saved;
    const result=await post<ClaimBatch>('batch-save',{id,baseVersion:saved?.version||'new',recordIDs,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version])),purpose,sourceMaterialIDs:sourceIDs});
    remember(result);return result;
  }
  async function run(action:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await action();await refresh();await onReload();}catch(e){setError(e instanceof Error?e.message:'操作失败，请刷新后重试。');}finally{setBusy(false);}}
  const target=records.find(r=>r.id===uploadRecord)||records[0];
  const canGenerate=records.length>=2&&records.every(r=>r.paymentVerified)&&amounts.total!==null&&!amounts.overLimit&&purpose.trim()&&!sourceIDs.some(id=>!evidence.some(m=>m.id===id&&m.integrity==='ok'));
  return createPortal(<dialog ref={dialog} className="batch-dialog" aria-label="合并准备报销材料" onCancel={e=>{e.preventDefault();e.stopPropagation();close();}} onKeyDown={e=>e.stopPropagation()}>
    <header><div><h2>合并准备报销材料</h2><p>{batchTitle(records)}</p></div><button aria-label="关闭合并材料" onClick={close} disabled={busy||uploadBusy}>×</button></header>
    <div className="batch-content">
      {discard&&<div role="alert" className="workflow-unsaved"><strong>共同说明或待上传文件尚未保存</strong><p>已保存的费用、附件和 PDF 不会被删除。</p><button className="button secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button className="button danger" onClick={onClose}>放弃未保存内容并关闭</button></div>}
      <p>保留每笔费用明细，共用一份情况说明和整合 PDF。按各自发票日期换算，合计限额 ¥4,000.00。</p>
      <div className="batch-amounts">{records.map((r,i)=><div key={r.id}><strong>{r.billingMonth} · {r.invoiceNumber}</strong><span>发票日 {r.date} · {r.currency} {r.amount}</span><span>{r.currency==='CNY'?'无需换汇':r.exchangeRate?.valid?`当日中行折算价 ${r.exchangeRate.quotedRate} / 100`:'待补发票日汇率'}</span><b>{amounts.amounts[i]?`¥${amounts.amounts[i]}`:'人民币待确认'}</b>{!r.paymentVerified&&<small>付款待核验</small>}</div>)}</div>
      <p className={amounts.overLimit?'feedback error':'batch-total'}>合计：{amounts.totalCNY?`¥${amounts.totalCNY}`:'缺少汇率，暂不能合计'} / ¥4,000.00{amounts.overLimit?'，已超限，请减少费用笔数。':''}</p>
      {locked&&<p className="form-hint">此包已有费用进入交付或财务流程，仅供查看；不自动改写已申报材料。</p>}
      <fieldset>
        <label htmlFor="batch-purpose">共同科研用途说明</label><textarea id="batch-purpose" disabled={busy||uploadBusy||!!generating||locked} rows={6} value={purpose} maxLength={6000} onChange={e=>setPurpose(e.target.value)} placeholder="写一次共同科研用途；下方选中的截图会放在这段说明之后。"/>
        {!saved&&state&&<button className="text-button" disabled={busy||uploadBusy||!!generating||locked} onClick={()=>setPurpose([...new Set(records.map(r=>{const p=state.purposes[r.id];return p?.confirmedText||p?.draft||p?.text||'';}).filter(Boolean))].join('\n\n'))}>填入这些费用已保存的用途说明</button>}
        <h3>科研截图</h3><p>勾选需要放入正文的图片或 PDF，点击文件可预览。</p>
        {evidence.map(m=><div className="batch-evidence" key={m.id}><input type="checkbox" aria-label={'纳入正文 '+m.filename} disabled={m.integrity!=='ok'||busy||uploadBusy||!!generating||locked} checked={sourceIDs.includes(m.id)} onChange={e=>setSourceIDs(ids=>e.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id))}/><AttachmentPreview href={m.href} filename={m.filename}/></div>)}
        {!evidence.length&&<p className="form-hint">尚无科研用途截图，可在下方上传。</p>}
      </fieldset>
      {!locked&&target&&<details><summary>补充科研截图</summary><label>附件归属费用<select disabled={pending||busy||uploadBusy} value={target.id} onChange={e=>setUploadRecord(e.target.value)}>{records.map(r=><option key={r.id} value={r.id}>{r.billingMonth} · {r.invoiceNumber}</option>)}</select></label><MaterialUpload key={target.id} record={target} role="purposeEvidence" onBusy={setUploadBusy} onPending={setPending} disabled={busy||!!generating} onReload={async()=>{const next=await api<Workspace>('/api/workspace');const old=new Set(evidence.map(m=>m.id));const added=next.records.filter(r=>recordIDs.includes(r.id)).flatMap(r=>r.materials.filter(m=>m.role==='purposeEvidence'&&m.integrity==='ok'&&!old.has(m.id))).map(m=>m.id);setSourceIDs(ids=>[...new Set([...ids,...added])].filter(id=>next.records.some(r=>recordIDs.includes(r.id)&&r.materials.some(m=>m.id===id))));await onReload();return next;}}/></details>}
      <div className="ai-actions"><button className="button secondary" disabled={busy||uploadBusy||pending||generating||locked} onClick={()=>void run(async()=>{await save();setMessage('合并包已保存。');})}>保存共同说明</button><button className="button secondary" disabled={busy||uploadBusy||pending||generating||locked||!canDraft} onClick={()=>void run(async()=>{const current=await save();await post('batch-purpose-draft',{id,baseVersion:current.version,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version]))});setAdoptedJobID('');setMessage('DeepSeek 整理已排队。可以关闭窗口，稍后回来查看草稿；原说明不会自动替换。');})}>{drafting?'DeepSeek 整理中…':'DeepSeek 整理说明'}</button><button className="button primary" disabled={busy||uploadBusy||pending||generating||locked||!canGenerate} onClick={()=>void run(async()=>{const current=await save();await post('batch-packet',{id,baseVersion:current.version,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version])),totalCNY:amounts.totalCNY,confirmed:true});const next=await api<Workspace>('/api/workspace');const updated=next.claimBatches?.find(b=>b.id===id);if(updated)remember(updated);setMessage('已确认逐笔金额，正在生成一份整合 PDF。');})}>{packetGenerating?'正在生成…':'确认逐笔金额，生成合并 PDF'}</button></div>
      <p className="form-hint">DeepSeek 会读取共同说明、各笔已有用途和勾选的科研截图，起草一份共同说明；不读取发票或付款附件，也不计算金额。{state&&!state.settings.configured?'请先在主页面 AI 设置中保存密钥。':''}</p>
      {purposeJob&&<section className="ai-job" aria-label="合并用途 AI 草稿"><strong>{batchPurposeLabel(purposeJob)}</strong>{purposeJob.error&&<p className="feedback error" role="alert">{purposeJob.error}</p>}{purposeJob.result?.missing?.map((text,i)=><p className="form-hint" key={i}>待补充：{text}</p>)}{purposeJob.result?.purpose&&<><label htmlFor="batch-purpose-draft">DeepSeek 草稿（尚未采用）</label><textarea id="batch-purpose-draft" rows={6} readOnly value={purposeJob.result.purpose}/><button className="button secondary" disabled={!canAdopt} onClick={()=>{setPurpose(purposeJob.result!.purpose!);setAdoptedJobID(purposeJob.id);setMessage('已填入共同说明，请检查或修改后保存，再确认生成 PDF。');}}>采用草稿到共同说明</button>{adoptedJobID===purposeJob.id?<p className="form-hint">已填入上方，可继续修改。以你保存或确认的共同说明为准。</p>:dirty&&<p className="form-hint">当前说明或截图有未保存的修改，请保存并重新整理，避免采用旧草稿覆盖修改。</p>}</>}</section>}
      {job&&<section className="ai-job"><strong>{stale?'内容已变化，需重新生成':job.status==='completed'?'合并 PDF 已生成':job.status==='queued'?'合并 PDF 排队中':job.status==='running'?'合并 PDF 生成中':job.status==='failed'?'生成失败':'任务已中断'}</strong>{job.error&&<p className="feedback error">{job.error}</p>}{job.result?.pdfMaterialID&&<><div className="ai-actions"><AuthenticatedFileLink className="button secondary" href={'/api/materials/'+encodeURIComponent(job.result.pdfMaterialID)}>查看完整 PDF（{job.result.pages} 页）</AuthenticatedFileLink>{job.result.docxMaterialID&&<AuthenticatedFileLink href={'/api/materials/'+encodeURIComponent(job.result.docxMaterialID)} download>下载共同说明 Word</AuthenticatedFileLink>}</div>{job.result.approved&&!stale?<p>已确认材料备妥。</p>:<button className="button primary" disabled={busy||dirty||pending||uploadBusy||!!stale||job.status!=='completed'} onClick={()=>void run(async()=>{await post('approve-packet',{jobID:job.id,confirmed:true});})}>我已检查，标记整个包材料备妥</button>}</>}</section>}
      {job?.result?.approved&&!stale&&<section><h3>合并包交财务</h3><p>整合 PDF 已含全部原件，只需交这一份。登记交付不代表 ARP 审批通过。</p>{delivery}</section>}
      {(error||loadError)&&<p className="feedback error" role="alert">{error||loadError}</p>}{message&&<p role="status">{message}</p>}
      {saved&&!locked&&<div className="batch-archive"><button className="text-button" disabled={busy||uploadBusy||pending||!!generating} onClick={()=>setArchive(!archive)}>取消此分组</button>{archive&&<div><p>恢复为逐笔显示。原始费用和附件保留，旧合并 PDF 仅作历史，不再用于提交。</p><button className="button danger" disabled={busy||uploadBusy} onClick={()=>void run(async()=>{await post('batch-archive',{id,baseVersion:saved.version});onClose();})}>确认取消分组</button></div>}</div>}
    </div>
  </dialog>,document.body);
}
