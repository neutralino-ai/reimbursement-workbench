import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {api,apiAddress} from './api';
import type {ClaimBatch,Workspace} from './types';
import {useAutomation} from './Automation';
import AttachmentPreview from './AttachmentPreview';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import MaterialUpload from './MaterialUpload';
import {batchAmounts,batchTitle,lockedForBatch} from './claim-batches';
import {batchPurposeLabel} from './batch-purpose';
import {batchAdoptionReason,batchPDFReason} from './batch-action-reasons';
import ActionButton from './ActionButton';
import {batchDraftKey,readBatchDraft,writeBatchDraft,type BatchLocalDraft} from './batch-local-draft';
import './claim-batches.css';

const sameIDs=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export default function BatchEditor({data,recordIDs,batch,onReload,onClose,delivery}:{data:Workspace;recordIDs:string[];batch?:ClaimBatch;onReload:()=>Promise<unknown>;onClose:()=>void;delivery?:ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null);
  const commands=useRef(new Map<string,string>());
  async function post<T>(action:string,payload:object):Promise<T>{
    const key=JSON.stringify([action,payload]);
    const body=commands.current.get(key)||JSON.stringify({...payload,operationId:crypto.randomUUID()});
    commands.current.set(key,body);
    try{const result=await api<T>('/api/automation/'+action,{method:'POST',body,signal:AbortSignal.timeout(30000)});commands.current.delete(key);return result;}
    catch(e){if(e instanceof Error&&e.name==='TimeoutError')throw new Error('请求等待超过 30 秒，服务器可能已接收。请先刷新状态核对；本次编辑仍保留，可暂存到本机。');throw e;}
  }
  const [cacheKey]=useState(()=>batchDraftKey(apiAddress(),recordIDs));
  const [localState]=useState(()=>{try{return {draft:readBatchDraft(localStorage,cacheKey),error:''};}catch{return {draft:null,error:'无法读取本机暂存。当前内容仍可编辑，请检查浏览器存储设置。'};}});
  const [localDraft,setLocalDraft]=useState(localState.draft);
  const [localNotice,setLocalNotice]=useState(localState.error);
  const [id]=useState(batch?.id||localState.draft?.id||crypto.randomUUID());
  const [saved,setSaved]=useState<ClaimBatch|undefined>(batch);
  const records=recordIDs.map(id=>data.records.find(r=>r.id===id)!).filter(Boolean);
  const evidence=[...new Map(records.flatMap(r=>r.materials.filter(m=>m.role==='purposeEvidence')).map(m=>[m.id,m])).values()];
  const [purpose,setPurpose]=useState(batch?.purpose||'');
  const [sourceIDs,setSourceIDs]=useState(batch?.sourceMaterialIDs||evidence.filter(m=>m.integrity==='ok').map(m=>m.id));
  const [baseline,setBaseline]=useState({purpose:batch?.purpose||'',sourceIDs:batch?.sourceMaterialIDs||evidence.filter(m=>m.integrity==='ok').map(m=>m.id)});
  const [busy,setBusy]=useState(false),[uploadBusy,setUploadBusy]=useState(false),[pending,setPending]=useState(false);
  const [uploadActivity,setUploadActivity]=useState('');
  const [uploadRecord,setUploadRecord]=useState(records[0]?.id||'');
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[discard,setDiscard]=useState(false),[archive,setArchive]=useState(false);
  const {state,refresh,error:loadError,updatedAt,refreshing}=useAutomation();
  const [editedDraft,setEditedDraft]=useState<{jobID:string;text:string}|null>(null);
  const [draftBaseline,setDraftBaseline]=useState('');
  const [phase,setPhase]=useState(''),[startedAt,setStartedAt]=useState<number|null>(null),[now,setNow]=useState(Date.now());
  const [localSnapshot,setLocalSnapshot]=useState('');
  const [submitted,setSubmitted]=useState<{kind:string;previousID?:string;at:number}|null>(null);
  const dirty=purpose!==baseline.purpose||!sameIDs(sourceIDs,baseline.sourceIDs);
  const snapshot=JSON.stringify({purpose,sourceIDs,editedDraft});
  const draftDirty=!!editedDraft&&editedDraft.text!==draftBaseline;
  const dirtyRef=useRef(false),busyRef=useRef(false);dirtyRef.current=((dirty||draftDirty)&&snapshot!==localSnapshot)||pending;busyRef.current=busy||uploadBusy;
  const amounts=batchAmounts(records),locked=records.some(r=>lockedForBatch(r,data));
  const job=state?.jobs.find(j=>j.kind==='batch-packet'&&j.batchID===id);
  const purposeJob=state?.jobs.find(j=>j.kind==='batch-purpose'&&j.batchID===id);
  const draftText=editedDraft?.jobID===purposeJob?.id?editedDraft?.text||'':purposeJob?.result?.purpose||'';
  const [adoptedJobID,setAdoptedJobID]=useState(''),[adoptedText,setAdoptedText]=useState('');
  const drafting=submitted?.kind==='batch-purpose'||!!purposeJob&&['queued','running'].includes(purposeJob.status);
  const packetGenerating=submitted?.kind==='batch-packet'||!!job&&['queued','running'].includes(job.status);
  const generating=drafting||packetGenerating;
  const hasDraftInput=!!(purpose.trim()||sourceIDs.length||records.some(r=>{const p=state?.purposes[r.id];return p?.confirmedText?.trim()||p?.draft?.trim()||p?.text?.trim();}));
  const adoptionWouldOverwrite=dirty&&!(adoptedJobID===purposeJob?.id&&purpose===adoptedText&&sameIDs(sourceIDs,baseline.sourceIDs));
  const packetDoc=data.documents?.find(d=>d.id===job?.result?.documentID);
  const stale=job?.current===false||job?.status==='stale'||packetDoc?.stale;
  const previousJob=useRef('');
  const previousBatchVersion=useRef(batch?.version);
  useEffect(()=>{const key=job?.id+':'+job?.status;if(previousJob.current&&previousJob.current!==key)void onReload().catch(()=>{});previousJob.current=key;},[job?.id,job?.status,onReload]);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
  useEffect(()=>{if(submitted){const latest=submitted.kind==='batch-purpose'?purposeJob:job;if(latest&&latest.id!==submitted.previousID)setSubmitted(null);}},[submitted,purposeJob,job]);
  useEffect(()=>{const latest=data.claimBatches?.find(b=>b.id===id);if(latest?.version===previousBatchVersion.current)return;previousBatchVersion.current=latest?.version;if(latest&&!busy&&!dirty&&latest.version!==saved?.version)remember(latest);},[data.claimBatches,busy,dirty,id,saved?.version]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setStartedAt(uploadBusy?Date.now():null);},[uploadBusy]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirtyRef.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  function close(){if(busyRef.current)return;if(dirtyRef.current)setDiscard(true);else onClose();}
  function stash(){
    const value:BatchLocalDraft={schema:1,id,recordIDs,baseVersion:saved?.version||'new',savedAt:new Date().toISOString(),purpose,sourceIDs,draft:editedDraft|| (purposeJob?.result?.purpose?{jobID:purposeJob.id,text:purposeJob.result.purpose}:null)};
    try{writeBatchDraft(localStorage,cacheKey,value);window.dispatchEvent(new Event('reimbursement-batch-draft'));setLocalDraft(value);setLocalSnapshot(snapshot);setLocalNotice('已暂存到本机 '+new Date(value.savedAt).toLocaleTimeString()+'。'+(pending?'待上传文件未缓存，关闭后需重新选择。':''));return true;}
    catch{setLocalNotice('暂存失败：本机存储不可用或空间不足。请保留窗口并复制文字备份。');return false;}
  }
  function restore(){
    if(!localDraft)return;
    setPurpose(localDraft.purpose);setSourceIDs(localDraft.sourceIDs);setEditedDraft(localDraft.draft);setDraftBaseline(localDraft.draft?.text||'');
    setLocalSnapshot(JSON.stringify({purpose:localDraft.purpose,sourceIDs:localDraft.sourceIDs,editedDraft:localDraft.draft}));
    setLocalNotice(localDraft.baseVersion!==(saved?.version||'new')?'已恢复本机暂存；服务器版本已变化，请核对说明和截图后再保存。':'已恢复本机暂存，尚未保存到服务器。');
  }
  function remember(value:ClaimBatch){setSaved(value);setPurpose(value.purpose);setSourceIDs(value.sourceMaterialIDs);setBaseline({purpose:value.purpose,sourceIDs:value.sourceMaterialIDs});}
  async function save(){
    if(saved&&!dirty)return saved;
    const result=await post<ClaimBatch>('batch-save',{id,baseVersion:saved?.version||'new',recordIDs,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version])),purpose,sourceMaterialIDs:sourceIDs});
    remember(result);return result;
  }
  async function reload(){try{await onReload();}catch{setError('操作后的页面刷新失败，请刷新状态后核对结果；编辑内容已保留。');}}
  async function run(label:string,action:()=>Promise<void>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setPhase(label);setStartedAt(Date.now());setError('');setMessage('');try{await action();void refresh();void reload();}catch(e){setError(e instanceof Error?e.message:'操作失败，请刷新后重试。');}finally{busyRef.current=false;setBusy(false);setPhase('');setStartedAt(null);}}
  const activeJob=packetGenerating?job:drafting?purposeJob:undefined;
  const waitStart=startedAt||submitted?.at||(activeJob?Date.parse(activeJob.createdAt):null);
  const elapsed=waitStart?Math.max(0,Math.floor((now-waitStart)/1000)):0;
  const progress=phase||(uploadBusy?uploadActivity||'正在处理科研截图':submitted?'任务已提交，正在同步服务器进度':activeJob?.status==='queued'?'任务已提交，等待服务器开始':packetGenerating?'服务器正在生成合并 PDF':drafting?'DeepSeek 正在整理说明':!state?'正在读取任务状态':'可以继续编辑');
  const target=records.find(r=>r.id===uploadRecord)||records[0];
  const processingReason=busy?`${phase||'正在提交操作'}，请等待完成。`:uploadBusy?`${uploadActivity||'正在处理科研截图'}，请等待完成。`:'';
  const lockedReason=locked?'已有费用进入交付或财务流程，当前仅供查看。':'';
  const generatingReason=generating?`${progress}，完成后可继续操作。`:'';
  const pendingReason=pending?'有附件尚未上传，请先提交上传或取消待上传文件。':'';
  const editReason=lockedReason||processingReason||generatingReason;
  const mutationReason=editReason||pendingReason;
  const draftReason=mutationReason||(!state?(loadError?'暂时无法读取 AI 设置，请刷新状态后重试。':'正在读取 AI 设置，请稍候。'):!state.settings.configured?'请先在主页面“AI 设置”中保存 DeepSeek 密钥。':!hasDraftInput?'请填写共同说明、勾选科研截图，或先保存各笔费用的用途。':'');
  const pdfReason=mutationReason||batchPDFReason(records,purpose,sourceIDs,evidence);
  const adoptReason=mutationReason||batchAdoptionReason(purposeJob,saved?.version,draftText,adoptionWouldOverwrite);
  const approveReason=processingReason||(dirty?'共同说明或截图有修改，请保存并重新生成 PDF 后再检查。':'')||pendingReason||(stale?'PDF 的来源已变化，请重新生成并检查。':'')||(job?.status!=='completed'?'PDF 尚未生成完成，请等待任务完成后再检查。':'');
  return createPortal(<dialog ref={dialog} className="batch-dialog" aria-label="合并准备报销材料" onCancel={e=>{e.preventDefault();e.stopPropagation();close();}} onKeyDown={e=>e.stopPropagation()}>
    <header><div><h2>合并准备报销材料</h2><p>{batchTitle(records)}</p>{(busy||generating||uploadBusy||loadError)&&<p className="batch-header-status">{loadError?'状态连接异常，请查看提示':progress}{(busy||generating||uploadBusy)?` · ${elapsed} 秒`:''}</p>}</div><div className="batch-header-actions"><ActionButton className="button secondary" onClick={()=>stash()}>暂存到本机</ActionButton><ActionButton className="batch-close" aria-label="关闭合并材料" onClick={close} reason={processingReason}>×</ActionButton></div></header>
    <div className="batch-content">
      <section className="batch-progress" aria-label="当前处理状态"><strong role="status">{loadError?'暂时无法确认服务器进度':progress}</strong>{(busy||generating||uploadBusy)&&<span>已等待 {elapsed} 秒</span>}<p>{updatedAt?'上次成功更新：'+new Date(updatedAt).toLocaleTimeString():'尚未取得服务器状态'}{refreshing?' · 正在刷新…':''}</p>{(busy||generating||uploadBusy)&&elapsed>=30&&<p>耗时较长。可先暂存文字；服务器任务提交后可关闭窗口，稍后查看结果。</p>}{generating&&elapsed>=180&&<p>任务持续时间较长，仅凭等待时间无法判断是否卡住。请刷新状态检查，不要重复提交。</p>}<ActionButton className="text-button" reason={refreshing?'正在读取服务器状态，请稍候。':''} onClick={()=>{void refresh();void reload();}}>{refreshing?'正在刷新状态…':'刷新状态'}</ActionButton>{loadError&&<p className="feedback error" role="alert">{loadError}</p>}{error&&<p className="feedback error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}</section>
      <section className="batch-local" aria-label="本机暂存"><p>暂存共同说明、修改后的 DeepSeek 草稿及截图勾选，仅保存在当前设备的浏览器或应用中。待上传文件需重新选择；清理应用数据会删除暂存。</p>{localDraft&&<div><span>本机暂存于 {new Date(localDraft.savedAt).toLocaleString()} </span><ActionButton className="text-button" reason={lockedReason||processingReason||(localDraft.id!==id?'这份暂存属于其他合并包，不能恢复到当前包。':'' )} onClick={restore}>恢复暂存</ActionButton></div>}{localNotice&&<p role="status">{localNotice}</p>}</section>
      {editedDraft&&editedDraft.jobID!==purposeJob?.id&&<section className="ai-job"><label htmlFor="batch-recovered-draft">暂存的 DeepSeek 草稿（请核对当前费用与截图）</label><textarea id="batch-recovered-draft" rows={6} maxLength={6000} disabled={busy||uploadBusy||locked} value={editedDraft.text} onChange={e=>setEditedDraft({...editedDraft,text:e.target.value})}/><p className="form-hint">对应任务尚未加载或已有新任务。可继续编辑或复制文字到共同说明，核对后再保存。</p></section>}
      {discard&&<div role="alert" className="workflow-unsaved"><strong>说明、草稿或待上传文件尚未保存</strong><p>已保存的费用、附件和 PDF 不会被删除。{pending?'待上传文件不能暂存，关闭后需重新选择。':''}</p><ActionButton className="button secondary" onClick={()=>setDiscard(false)}>继续编辑</ActionButton><ActionButton className="button secondary" onClick={()=>{if(stash())onClose();}}>暂存并关闭</ActionButton><ActionButton className="button danger" onClick={onClose}>放弃未保存内容并关闭</ActionButton></div>}
      <p>保留每笔费用明细，共用一份报销说明 PDF，发票原件单独随 ZIP 提交。按各自发票日期换算，合计限额 ¥4,000.00。</p>
      <div className="batch-amounts">{records.map((r,i)=><div key={r.id}><strong>{r.billingMonth} · {r.invoiceNumber}</strong><span>发票日 {r.date} · {r.currency} {r.amount}</span><span>{r.currency==='CNY'?'无需换汇':r.exchangeRate?.valid?`当日中行折算价 ${r.exchangeRate.quotedRate} / 100`:'待补发票日汇率'}</span><b>{amounts.amounts[i]?`¥${amounts.amounts[i]}`:'人民币待确认'}</b>{!r.paymentVerified&&<small>付款待核验</small>}</div>)}</div>
      <p className={amounts.overLimit?'feedback error':'batch-total'}>合计：{amounts.totalCNY?`¥${amounts.totalCNY}`:'缺少汇率，暂不能合计'} / ¥4,000.00{amounts.overLimit?'，已超限，请减少费用笔数。':''}</p>
      {locked&&<p className="form-hint">此包已有费用进入交付或财务流程，仅供查看；不自动改写已申报材料。</p>}
      <fieldset>
        {editReason&&<p id="batch-edit-reason" className="action-disabled-reason">暂不能修改说明和截图：{editReason}</p>}
        <label htmlFor="batch-purpose">共同科研用途说明</label><textarea id="batch-purpose" aria-describedby={editReason?'batch-edit-reason':undefined} disabled={busy||uploadBusy||!!generating||locked} rows={6} value={purpose} maxLength={6000} onChange={e=>setPurpose(e.target.value)} placeholder="写一次共同科研用途；下方选中的截图会放在这段说明之后。"/>
        {!saved&&state&&<ActionButton className="text-button" reason={editReason} onClick={()=>setPurpose([...new Set(records.map(r=>{const p=state.purposes[r.id];return p?.confirmedText||p?.draft||p?.text||'';}).filter(Boolean))].join('\n\n'))}>填入这些费用已保存的用途说明</ActionButton>}
        <h3>科研截图</h3><p>勾选需要放入正文的图片或 PDF，点击文件可预览。</p>
        {evidence.map(m=><div className="batch-evidence" key={m.id}><input type="checkbox" aria-label={'纳入正文 '+m.filename} disabled={m.integrity!=='ok'||busy||uploadBusy||!!generating||locked} checked={sourceIDs.includes(m.id)} onChange={e=>setSourceIDs(ids=>e.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id))}/><AttachmentPreview href={m.href} filename={m.filename}/>{m.integrity!=='ok'&&<small className="action-disabled-reason">原件缺失或已变化，不能纳入正文；请重新上传。</small>}</div>)}
        {!evidence.length&&<p className="form-hint">尚无科研用途截图，可在下方上传。</p>}
      </fieldset>
      {!locked&&target&&<details><summary>补充科研截图</summary><label>附件归属费用<select aria-describedby={pending||busy||uploadBusy?'batch-upload-selection-reason':undefined} disabled={pending||busy||uploadBusy} value={target.id} onChange={e=>setUploadRecord(e.target.value)}>{records.map(r=><option key={r.id} value={r.id}>{r.billingMonth} · {r.invoiceNumber}</option>)}</select></label>{(processingReason||pendingReason)&&<p id="batch-upload-selection-reason" className="action-disabled-reason">暂不能切换附件归属：{processingReason||pendingReason}</p>}<MaterialUpload key={target.id} record={target} role="purposeEvidence" onBusy={setUploadBusy} onActivity={setUploadActivity} onPending={setPending} disabled={busy||!!generating} disabledReason={processingReason||generatingReason} onReload={async()=>{const next=await api<Workspace>('/api/workspace');const old=new Set(evidence.map(m=>m.id));const added=next.records.filter(r=>recordIDs.includes(r.id)).flatMap(r=>r.materials.filter(m=>m.role==='purposeEvidence'&&m.integrity==='ok'&&!old.has(m.id))).map(m=>m.id);setSourceIDs(ids=>[...new Set([...ids,...added])].filter(id=>next.records.some(r=>recordIDs.includes(r.id)&&r.materials.some(m=>m.id===id))));await onReload();return next;}}/></details>}
      <div className="ai-actions"><ActionButton className="button secondary" reason={mutationReason} onClick={()=>void run('正在保存共同说明',async()=>{await save();setMessage('合并包已保存到服务器。');})}>保存共同说明</ActionButton><ActionButton className="button secondary" reason={draftReason} onClick={()=>void run('正在保存说明并提交 DeepSeek 任务',async()=>{const current=await save();await post('batch-purpose-draft',{id,baseVersion:current.version,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version]))});setSubmitted({kind:'batch-purpose',previousID:purposeJob?.id,at:Date.now()});setAdoptedJobID('');setMessage('DeepSeek 整理已排队。可以关闭窗口，稍后回来查看草稿；原说明不会自动替换。');})}>{drafting?'DeepSeek 整理中…':'DeepSeek 整理说明'}</ActionButton><ActionButton className="button primary" reason={pdfReason} onClick={()=>void run('正在保存说明并提交 PDF 生成任务',async()=>{const current=await save();await post('batch-packet',{id,baseVersion:current.version,recordVersions:Object.fromEntries(records.map(r=>[r.id,r.version])),totalCNY:amounts.totalCNY,confirmed:true});setSubmitted({kind:'batch-packet',previousID:job?.id,at:Date.now()});setMessage('已确认逐笔金额，正在生成一份报销说明 PDF。');})}>{packetGenerating?'正在生成…':'确认逐笔金额，生成合并 PDF'}</ActionButton></div>
      <p className="form-hint">DeepSeek 会读取共同说明、各笔已有用途和勾选的科研截图，起草一份共同说明；不读取发票或付款附件，也不计算金额。{state&&!state.settings.configured?'请先在主页面 AI 设置中保存密钥。':''}</p>
      {purposeJob&&<section className="ai-job" aria-label="合并用途 AI 草稿"><strong>{batchPurposeLabel(purposeJob)}</strong>{purposeJob.error&&<p className="feedback error" role="alert">{purposeJob.error}</p>}{purposeJob.result?.missing?.map((text,i)=><p className="form-hint" key={i}>待补充：{text}</p>)}{purposeJob.result?.purpose&&<><label htmlFor="batch-purpose-draft">DeepSeek 草稿（可直接修改，采用后用于共同说明）</label><textarea id="batch-purpose-draft" rows={6} maxLength={6000} disabled={locked||busy||uploadBusy} value={draftText} onChange={e=>{if(editedDraft?.jobID!==purposeJob.id)setDraftBaseline(purposeJob.result!.purpose!);setEditedDraft({jobID:purposeJob.id,text:e.target.value});}}/><ActionButton className="button secondary" reason={adoptReason} onClick={()=>{setPurpose(draftText);setAdoptedJobID(purposeJob.id);setAdoptedText(draftText);setDraftBaseline(draftText);setMessage('已将修改后的草稿填入共同说明，请检查后保存，再确认生成 PDF。');}}>采用当前草稿到共同说明</ActionButton>{adoptedJobID===purposeJob.id?<p className="form-hint">已填入上方。若继续修改草稿，需再次采用；最终以上方共同说明为准。</p>:dirty&&<p className="form-hint">当前说明或截图有未保存的修改，请保存并重新整理，避免采用旧草稿覆盖修改。</p>}</>}</section>}
      {job&&<section className="ai-job"><strong>{stale?'内容已变化，需重新生成':job.status==='completed'?'合并 PDF 已生成':job.status==='queued'?'合并 PDF 排队中':job.status==='running'?'合并 PDF 生成中':job.status==='failed'?'生成失败':'任务已中断'}</strong>{job.error&&<p className="feedback error">{job.error}</p>}{job.result?.pdfMaterialID&&<><div className="ai-actions"><AuthenticatedFileLink className="button secondary" href={'/api/materials/'+encodeURIComponent(job.result.pdfMaterialID)}>查看报销说明 PDF（{job.result.pages} 页）</AuthenticatedFileLink>{job.result.docxMaterialID&&<AuthenticatedFileLink href={'/api/materials/'+encodeURIComponent(job.result.docxMaterialID)} download>下载共同说明 Word</AuthenticatedFileLink>}</div>{job.result.approved&&!stale?<p>已确认材料备妥。</p>:<ActionButton className="button primary" reason={approveReason} onClick={()=>void run('正在保存材料核验结果',async()=>{await post('approve-packet',{jobID:job.id,confirmed:true});})}>我已检查，标记整个包材料备妥</ActionButton>}</>}</section>}
      {job?.result?.approved&&!stale&&<section><h3>合并包交财务</h3><p>在主页面“申报 ZIP”中打包说明 PDF 和各笔发票原件。付款、汇率及科研截图保留在说明内。登记交付不代表财务审核通过。</p>{delivery}</section>}
      {saved&&!locked&&<div className="batch-archive"><ActionButton className="text-button" reason={mutationReason} onClick={()=>setArchive(!archive)}>取消此分组</ActionButton>{archive&&<div><p>恢复为逐笔显示。原始费用和附件保留，旧合并 PDF 仅作历史，不再用于提交。</p><ActionButton className="button danger" reason={processingReason} onClick={()=>void run('正在取消分组',async()=>{await post('batch-archive',{id,baseVersion:saved.version});onClose();})}>确认取消分组</ActionButton></div>}</div>}
    </div>
  </dialog>,document.body);
}
