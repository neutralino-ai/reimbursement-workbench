import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import MaterialUpload from './MaterialUpload';
import type {RecordItem,Workspace} from './types';
import './automation.css';

type Job={id:string;kind:string;recordID?:string;status:string;createdAt:string;finishedAt?:string;error?:string;current?:boolean;result?:{reasons?:string[];documentID?:string;pdfMaterialID?:string;docxMaterialID?:string;materialID?:string;approved?:boolean;pages?:number;invoiceCheck?:{checks:{field:string;result:string}[]};paymentCheck?:{checks:{field:string;result:string}[]}}};
type Purpose={version:string;text:string;sourceMaterialIDs:string[];draft:string;missing:string[];confirmedText?:string};
type AutomationState={settings:{configured:boolean;enabled:boolean;keyHint:string;model:string;revision:string;lastTest?:{ok:boolean;at:string}|null};jobs:Job[];purposes:Record<string,Purpose>};
const labels:Record<string,string>={queued:'排队中',running:'处理中',matched:'核验通过',mismatch:'字段不符',needs_review:'需人工核对',failed:'处理失败',interrupted:'任务已中断',stale:'内容已变化',completed:'已生成'};
const fieldLabels:Record<string,string>={merchant:'商户',invoiceNumber:'发票编号',date:'日期',amount:'原币金额',currency:'币种',status:'结算状态',duplicate:'重复凭证'};
const post=<T,>(action:string,data:object)=>api<T>('/api/automation/'+action,{method:'POST',body:JSON.stringify({...data,operationId:crypto.randomUUID()})});
const fileHref=(id:string)=>'/api/materials/'+encodeURIComponent(id);
function useAutomation(){
  const [state,setState]=useState<AutomationState|null>(null),[error,setError]=useState('');
  async function refresh(){try{const data=await api<AutomationState>('/api/automation');setState(data);setError('');return data;}catch(e){setError(e instanceof Error?e.message:'无法读取自动化状态');return null;}}
  useEffect(()=>{let alive=true,inFlight=false;const poll=async()=>{if(inFlight)return;inFlight=true;try{const data=await api<AutomationState>('/api/automation');if(alive){setState(data);setError('');}}catch(e){if(alive)setError(e instanceof Error?e.message:'读取失败');}finally{inFlight=false;}};void poll();const timer=setInterval(()=>void poll(),3000);return()=>{alive=false;clearInterval(timer);};},[]);
  return {state,error,refresh};
}
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();},[]);return <dialog ref={dialog} className="ai-dialog" onCancel={onClose} aria-label={title}><header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>{children}</dialog>;}

export function AutomationToolbar({data,onReload}:{data:Workspace;onReload:()=>Promise<Workspace>}){
  const [view,setView]=useState<'settings'|'zip'|null>(null);
  return <><button type="button" className="button secondary" onClick={()=>setView('settings')}>AI 设置</button><button type="button" className="button secondary" onClick={()=>setView('zip')}>申报 ZIP</button>{view==='settings'&&<Modal title="DeepSeek 设置" onClose={()=>setView(null)}><AISettings/></Modal>}{view==='zip'&&<Modal title="打包申报材料" onClose={()=>setView(null)}><ZipPanel data={data} onReload={onReload}/></Modal>}</>;
}
function AISettings(){
  const {state,error:loadError,refresh}=useAutomation();const [key,setKey]=useState(''),[enabled,setEnabled]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[initialized,setInitialized]=useState(false);
  useEffect(()=>{if(state&&!initialized){setEnabled(state.settings.enabled||!state.settings.configured);setInitialized(true);}},[state,initialized]);
  async function action(test:boolean){setBusy(true);setError('');setMessage('');try{
    if(test){const result=await post<{elapsedMs:number}>('test',{...(key?{apiKey:key}:{})});setMessage(`连接成功（${result.elapsedMs} ms）。${key?'新密钥尚未保存。':''}`);}
    else{await post('settings',{baseVersion:state?.settings.revision,enabled,...(key?{apiKey:key}:{})});setKey('');setMessage('设置已保存。');await refresh();}
  }catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <div className="ai-form"><p>上传的发票与付款凭证由服务器核验。密钥仅通过 HTTPS 提交，保存在服务器，客户端不缓存密钥。</p><label>DeepSeek API Key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e=>setKey(e.target.value)} placeholder={state?.settings.configured?`已保存 ${state.settings.keyHint}；留空保留原密钥`:'sk-…'}/></label><label className="ai-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>上传后自动核验</label><p className="small-muted">模型：deepseek-flash · Responses 非流式</p>{state?.settings.lastTest&&<p className="small-muted">已保存密钥上次验证：{new Date(state.settings.lastTest.at).toLocaleString()}</p>}<div className="ai-actions"><button className="button secondary" disabled={busy||(!key&&!state?.settings.configured)} onClick={()=>void action(true)}>{busy?'处理中…':'检验连接'}</button><button className="button primary" disabled={busy||!state} onClick={()=>void action(false)}>保存设置</button></div>{(error||loadError)&&<p className="feedback error" role="alert">{error||loadError}</p>}{message&&<p role="status">{message}</p>}</div>;
}
function ZipPanel({data,onReload}:{data:Workspace;onReload:()=>Promise<Workspace>}){
  const {state,refresh,error:loadError}=useAutomation();const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const docs=(data.documents||[]).filter(d=>d.purpose==='application'&&d.status==='ready'&&!d.stale&&!d.needsUpdate);
  async function build(){setBusy(true);setError('');try{await post('zip',{documentIDs:selected});await refresh();await onReload();}catch(e){setError(e instanceof Error?e.message:'打包失败');}finally{setBusy(false);}}
  return <div className="ai-form"><p>每笔费用一份完整 PDF；ZIP 内只放所选 PDF。先在各笔“申报材料”中检查并确认生成结果。</p>{docs.map(d=><label className="ai-check" key={d.id}><input type="checkbox" checked={selected.includes(d.id)} onChange={e=>setSelected(v=>e.target.checked?[...v,d.id]:v.filter(id=>id!==d.id))}/>{d.title}</label>)}{!docs.length&&<p className="form-hint">暂无已确认的申报 PDF。</p>}<button className="button primary" disabled={busy||!selected.length} onClick={()=>void build()}>生成 ZIP（{selected.length} 份 PDF）</button>{state?.jobs.filter(j=>j.kind==='zip').slice(0,4).map(j=><div key={j.id} data-job-id={j.id} className="ai-job"><strong>{labels[j.status]}</strong>{j.error&&<p className="feedback error">{j.error}</p>}{j.status==='completed'&&j.result?.materialID&&<AuthenticatedFileLink href={fileHref(j.result.materialID)} download="reimbursement-package.zip" className="text-button">下载申报 ZIP</AuthenticatedFileLink>}</div>)}{(error||loadError)&&<p className="feedback error" role="alert">{error||loadError}</p>}</div>;
}
export function AIRecordPanel({record,mode,onReload,onDirty,onBusy}:{record:RecordItem;mode:'review'|'purpose';onReload:()=>Promise<Workspace>;onDirty:(value:boolean)=>void;onBusy:(value:boolean)=>void}){
  const {state,error:loadError,refresh}=useAutomation();const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [invoiceID,setInvoiceID]=useState(''),[paymentID,setPaymentID]=useState('');
  const [text,setText]=useState(''),[draft,setDraft]=useState(''),[dirty,setDirty]=useState(false),[seedVersion,setSeedVersion]=useState('');
  const purpose=state?.purposes[record.id];
  const jobs=state?.jobs.filter(j=>j.recordID===record.id)||[];const review=jobs.find(j=>j.kind==='review'),packet=jobs.find(j=>j.kind==='packet'),purposeJob=jobs.find(j=>j.kind==='purpose');
  const seen=useRef(new Set<string>()),initialJobs=useRef(false),reload=useRef(onReload);reload.current=onReload;
  useEffect(()=>{if(!state)return;for(const j of jobs){if(!['queued','running'].includes(j.status)){const key=j.id+j.status;if(initialJobs.current&&!seen.current.has(key))void reload.current().catch(()=>{});seen.current.add(key);}}initialJobs.current=true;},[state]);
  useEffect(()=>{if(purpose&&purpose.version!==seedVersion&&!dirty){setText(purpose.text);setDraft(purpose.confirmedText||purpose.draft||purpose.text);setSeedVersion(purpose.version);}},[purpose,seedVersion,dirty]);
  const edit=(fn:()=>void)=>{fn();setDirty(true);onDirty(true);};
  async function run(action:()=>Promise<unknown>){setBusy(true);onBusy(true);setError('');try{await action();await refresh();await onReload();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);onBusy(false);}}
  async function save(){const result=await post<Purpose>('purpose',{recordID:record.id,recordVersion:record.version,baseVersion:purpose?.version||'new',text,sourceMaterialIDs:record.materials.filter(m=>m.role==='purposeEvidence'&&m.integrity==='ok').map(m=>m.id)});setDirty(false);onDirty(false);return result;}
  const generating=[purposeJob,packet].some(j=>j&&['queued','running'].includes(j.status));
  const amount=record.currency==='CNY'?record.amount:record.exchangeRate?.valid?record.exchangeRate.cnyAmount:null;
  if(record.priorStepsComplete||record.financeReviewPending||record.status==='completed')return null;
  return <section className="drawer-section ai-panel"><h3>{mode==='review'?'自动核验':'用途与申报材料'}</h3>
    {mode==='review'?<>
      <p>{state?.settings.enabled?'上传后自动检查发票及付款字段。':'请在主页面 AI 设置中配置密钥并启用自动核验。'}</p>
      {(['invoice','payment'] as const).map(role=>{const files=record.materials.filter(m=>m.role===role&&m.integrity==='ok');return files.length>1?<label key={role}>{role==='invoice'?'选择发票原件':'选择付款凭证'}<select value={(role==='invoice'?invoiceID:paymentID)||files[0].id} onChange={e=>role==='invoice'?setInvoiceID(e.target.value):setPaymentID(e.target.value)}>{files.map(m=><option key={m.id} value={m.id}>{m.filename}</option>)}</select></label>:null;})}
      {review&&<div className="ai-job"><strong>{review.current===false?'原件已变化，结果待更新':labels[review.status]}</strong>{review.error&&<p className="feedback error">{review.error}</p>}{review.result?.reasons?.map((reason,i)=><p className="form-hint" key={i}>{reason}</p>)}{[review.result?.invoiceCheck,review.result?.paymentCheck].map((group,i)=>group&&<details key={i}><summary>{i===0?'发票核验字段':'付款核验字段'}</summary><dl className="ai-checks">{group.checks.map(c=><div key={c.field}><dt>{fieldLabels[c.field]||c.field}</dt><dd>{c.result==='match'?'匹配':c.result==='mismatch'?'不匹配':'待核对'}</dd></div>)}</dl></details>)}</div>}
      <button className="button secondary" disabled={busy||!state?.settings.enabled||['queued','running'].includes(review?.status||'')} onClick={()=>void run(async()=>{await post('review',{recordID:record.id,baseVersion:record.version,materialIDs:[invoiceID||record.materials.find(m=>m.role==='invoice'&&m.integrity==='ok')?.id,paymentID||record.materials.find(m=>m.role==='payment'&&m.integrity==='ok')?.id].filter(Boolean)});})}>重新核验</button><p className="small-muted">核验结论保留 Agent 身份，不代替人工确认或财务审核。</p>
    </>:<>
      <label htmlFor="purpose-source">用途原文</label><textarea id="purpose-source" aria-label="用途原文" rows={4} value={text} onChange={e=>edit(()=>setText(e.target.value))} placeholder="用于什么科研或工作？用 ChatGPT 完成了哪些具体工作？"/><p className="small-muted">可用系统语音听写输入：Windows 按 Win + H；Mac 使用已配置的听写快捷键。手机可用键盘麦克风。</p>
      <MaterialUpload record={record} role="purposeEvidence" onReload={onReload} onBusy={onBusy}/>
      {record.materials.filter(m=>m.role==='purposeEvidence').map(m=><AuthenticatedFileLink key={m.id} className="text-button" href={m.href}>{m.filename}</AuthenticatedFileLink>)}
      <div className="ai-actions"><button className="button secondary" disabled={busy||generating} onClick={()=>void run(async()=>{await save();})}>保存用途</button><button className="button secondary" disabled={busy||generating||!state?.settings.configured} onClick={()=>void run(async()=>{const saved=await save();await post('purpose-draft',{recordID:record.id,purposeVersion:saved.version});})}>DeepSeek 整理说明</button></div>
      {purposeJob&&<p className="small-muted">用途整理：{labels[purposeJob.status]}{purposeJob.error&&` · ${purposeJob.error}`}</p>}
      {purpose?.missing?.length? <div className="ai-missing">{purpose.missing.map((m,i)=><p key={i}>{m}</p>)}</div>:null}
      <label htmlFor="purpose-final">提交 PDF 中的用途说明</label><textarea id="purpose-final" aria-label="提交 PDF 中的用途说明" rows={5} value={draft} onChange={e=>edit(()=>setDraft(e.target.value))} placeholder="AI 整理后可在此修改，也可以直接填写最终说明。"/>
      <p>本笔申报金额：<strong>{amount?`CNY ${amount}`:'待补发票日汇率'}</strong></p>
      <button className="button primary" disabled={busy||generating||!draft.trim()||!amount||!record.paymentVerified} onClick={()=>void run(async()=>{let current=purpose;const attachments=record.materials.filter(m=>m.role==='purposeEvidence'&&m.integrity==='ok').map(m=>m.id);if(!current||text!==current.text||JSON.stringify(attachments)!==JSON.stringify(current.sourceMaterialIDs))current=await save();const latest=await onReload();const updated=latest.records.find(r=>r.id===record.id)!;await post('packet',{recordID:record.id,baseVersion:updated.version,purposeVersion:current.version,purpose:draft,claimedCNY:amount,confirmed:true});setDirty(false);onDirty(false);})}>确认用途及金额，生成 PDF 草稿</button>
      {!record.paymentVerified&&<p className="form-hint">需先完成发票与实付款核验。</p>}
      {packet&&<div className="ai-job"><strong>申报材料：{labels[packet.status]}</strong>{packet.error&&<p className="feedback error">{packet.error}</p>}{packet.result?.pdfMaterialID&&<><div className="ai-actions"><AuthenticatedFileLink className="button secondary" href={fileHref(packet.result.pdfMaterialID)}>查看完整 PDF（{packet.result.pages} 页）</AuthenticatedFileLink>{packet.result.docxMaterialID&&<AuthenticatedFileLink className="text-button" href={fileHref(packet.result.docxMaterialID)} download>下载说明 Word</AuthenticatedFileLink>}</div><p className="small-muted">请检查用途、金额及全部附件。确认后可在主页面将多笔 PDF 打包为 ZIP。</p>{packet.status==='stale'?<p>内容已变化，请重新生成；上方文件仅供查看历史。</p>:packet.result.approved?<p>已确认材料备妥。</p>:<button className="button primary" disabled={busy} onClick={()=>void run(async()=>{await post('approve-packet',{jobID:packet.id,confirmed:true});})}>我已检查 PDF，标记材料备妥</button>}</>}</div>}
    </>}{(error||loadError)&&<p className="feedback error" role="alert">{error||loadError}</p>}
  </section>;
}
