import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import AttachmentPreview from './AttachmentPreview';
import VendorBadge,{vendorLabel} from './VendorBadge';
import type {Workspace} from './types';
import type {WorkflowStepId} from './workflow';
import './screenshot-inbox.css';

type Item={id:string;version:string;filename:string;href:string;status:string;role?:string;kind?:string;recordID?:string;reason?:string;error?:string;summary?:string;candidates:{recordID:string;exact:boolean}[]};
type Inbox={enabled:boolean;items:Item[]};
type Props={data:Workspace;onReload:()=>Promise<unknown>;onOpenRecord:(id:string,step:WorkflowStepId)=>void};
const labels:Record<string,string>={queued:'排队中',running:'识别匹配中',matched:'已归档',needs_review:'待确认',failed:'识别失败',interrupted:'已中断',duplicate:'已有凭证',ignored:'已忽略',unlinked:'关联已移除'};
const active=(item:Item)=>!['matched','duplicate','ignored'].includes(item.status);
const kindLabel=(role?:string)=>role==='invoice'?'发票':role==='payment'?'付款凭证':role==='purposeEvidence'?'用途截图':'其他截图';
const post=<T,>(action:string,input:object)=>api<T>('/api/automation/'+action,{method:'POST',body:JSON.stringify(input)});

export default function ScreenshotInboxButton(props:Props){
  const [open,setOpen]=useState(false);
  return <><div className="screenshot-entry"><button className="button primary" onClick={()=>setOpen(true)}>批量传截图</button><span>自动识别并匹配费用</span></div>{open&&<InboxDialog {...props} onClose={()=>setOpen(false)}/>}</>;
}
function InboxDialog({data,onReload,onOpenRecord,onClose}:Props&{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),lock=useRef(false),reload=useRef(onReload);reload.current=onReload;
  const [state,setState]=useState<Inbox|null>(null),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [pending,setPending]=useState<{id:string;file:File}[]>([]),[filter,setFilter]=useState<'pending'|'all'>('pending');
  const signature=useRef('');
  useEffect(()=>{dialog.current?.showModal();let alive=true,inFlight=false;
    const poll=async()=>{if(inFlight)return;inFlight=true;try{const next=await api<Inbox>('/api/automation/inbox');if(!alive)return;setState(next);setLoadError('');const changed=next.items.filter(i=>i.status==='matched').map(i=>i.id+':'+i.version).join('|');if(changed!==signature.current){signature.current=changed;void reload.current().catch(()=>{});}}catch(e){if(alive)setLoadError(e instanceof Error?e.message:'收件箱读取失败');}finally{inFlight=false;}};
    void poll();const timer=setInterval(()=>void poll(),3000);return()=>{alive=false;clearInterval(timer);};
  },[]);
  function choose(files:FileList|null){
    if(lock.current)return;setError('');setMessage('');const additions:{id:string;file:File}[]=[],errors:string[]=[];
    for(const file of Array.from(files||[])){
      if(!file.size||file.size>20*1024*1024||! /\.(png|jpe?g|webp)$/i.test(file.name)){errors.push(file.name+'：请选择 20 MB 内的 PNG、JPEG 或 WebP 截图。');continue;}
      if(pending.length+additions.length>=20){errors.push('每次最多选择 20 张，请分批上传。');break;}
      additions.push({id:crypto.randomUUID(),file});
    }
    setPending(previous=>[...previous,...additions]);setError(errors.join(' '));if(input.current)input.current.value='';
  }
  async function refresh(){setState(await api<Inbox>('/api/automation/inbox'));await onReload();}
  async function upload(){if(lock.current||!pending.length)return;lock.current=true;setBusy(true);setError('');setFilter('all');let count=0;
    try{for(const item of pending){
      const contentBase64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取 '+item.file.name));reader.readAsDataURL(item.file);});
      await post('inbox-upload',{operationId:item.id,filename:item.file.name,contentBase64});count++;setPending(previous=>previous.filter(p=>p.id!==item.id));setMessage(`已接收 ${count} / ${pending.length} 张，服务器继续识别，可稍后回来查看。`);
    }await refresh();}catch(e){setError((e instanceof Error?e.message:'上传失败')+' 未成功的截图仍在待上传列表，可再次提交。');}finally{lock.current=false;setBusy(false);}
  }
  const shown=state?.items.filter(i=>filter==='all'||active(i))||[];
  return <dialog ref={dialog} className="ai-dialog screenshot-dialog" aria-label="批量截图收件箱" onCancel={event=>{event.preventDefault();if(!lock.current)onClose();}}>
    <header><h2>批量截图</h2><button type="button" aria-label="关闭截图收件箱" disabled={busy} onClick={onClose}>×</button></header>
    <p className="screenshot-intro">一次选一批，不用先选费用。匹配明确的自动归档，其余在这里确认。</p>
    <input className="sr-only" ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="选择一批截图" onChange={e=>choose(e.target.files)} disabled={busy}/>
    <button className="button secondary" disabled={busy} onClick={()=>input.current?.click()}>从相册选择截图</button>
    {state&&!state.enabled&&<p className="feedback error">请先到首页“AI 设置”配置并启用 DeepSeek。</p>}
    {!!pending.length&&<div className="screenshot-pending"><strong>待上传 {pending.length} 张</strong>{pending.map(item=><div key={item.id}><AttachmentPreview file={item.file}/><button className="text-button" disabled={busy} onClick={()=>setPending(previous=>previous.filter(p=>p.id!==item.id))}>移除</button></div>)}<button className="button primary" disabled={busy||!state?.enabled} onClick={()=>void upload()}>{busy?'上传中…':`上传并自动匹配（${pending.length}）`}</button></div>}
    {message&&<p role="status" className="screenshot-intro">{message}</p>}{(error||loadError)&&<p className="feedback error" role="alert">{error||loadError}</p>}
    <div className="ov-filters screenshot-filters" role="group" aria-label="截图筛选"><button className={filter==='pending'?'is-active':''} aria-pressed={filter==='pending'} onClick={()=>setFilter('pending')}>待处理 {state?.items.filter(active).length||0}</button><button className={filter==='all'?'is-active':''} aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部 {state?.items.length||0}</button></div>
    {shown.map(item=><InboxItem key={item.id+item.version} item={item} data={data} onRefresh={refresh} onOpen={()=>{if(item.recordID){onClose();onOpenRecord(item.recordID,item.role==='invoice'?'materials':item.role==='purposeEvidence'?'claim':'payment');}}}/>)}
    {state&&!shown.length&&<p className="screenshot-intro">{state.items.length?'没有待处理的截图。':'尚未上传截图。'}</p>}
  </dialog>;
}
function InboxItem({item,data,onRefresh,onOpen}:{item:Item;data:Workspace;onRefresh:()=>Promise<void>;onOpen:()=>void}){
  const [recordID,setRecordID]=useState(''),[role,setRole]=useState(item.role||'payment'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const record=data.records.find(r=>r.id===item.recordID),canResolve=['needs_review','failed','interrupted','unlinked','ignored','duplicate'].includes(item.status);
  const choices=data.records.filter(r=>!r.financeReviewPending&&r.status!=='completed').sort((a,b)=>Number(item.candidates.some(c=>c.recordID===b.id))-Number(item.candidates.some(c=>c.recordID===a.id))||b.date.localeCompare(a.date));
  const selected=choices.find(r=>r.id===recordID);
  async function run(action:'attach'|'ignore'|'retry'){setBusy(true);setError('');try{
    await post(action==='retry'?'inbox-retry':'inbox-resolve',{operationId:crypto.randomUUID(),id:item.id,baseVersion:item.version,...(action==='retry'?{}:{action}),...(action==='attach'?{role,recordID,recordVersion:selected?.version,confirmed:true}:{})});await onRefresh();
  }catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{setBusy(false);}}
  return <article className={'screenshot-item '+(item.status==='matched'?'is-matched':'')}>
    <div className="screenshot-item-head"><strong>{labels[item.status]||item.status}</strong><span>{kindLabel(item.role||item.kind)}</span></div>
    <AttachmentPreview href={item.href} filename={item.filename}/>
    {item.summary&&<p className="screenshot-summary">{item.summary}</p>}
    {record&&<button className="screenshot-record" onClick={onOpen}><VendorBadge vendor={record.vendor}/><span>{record.date} · {record.currency} {record.amount}<small>{record.accountName}</small></span><span aria-hidden="true">›</span></button>}
    {item.reason&&<p className="screenshot-intro">{item.reason}</p>}{item.error&&<p className="feedback error">{item.error}</p>}
    {canResolve&&<details className="screenshot-correction"><summary>选择归属 / 调整类型</summary><label>材料类型<select value={role} onChange={e=>setRole(e.target.value)}><option value="payment">付款凭证</option><option value="invoice">发票</option><option value="purposeEvidence">用途截图</option></select></label><label>对应费用<select value={recordID} onChange={e=>setRecordID(e.target.value)}><option value="">选择费用（包含账号）</option>{choices.map(r=><option value={r.id} key={r.id}>{vendorLabel(r.vendor)} · {r.date} · {r.currency} {r.amount} · {r.accountName} · {r.invoiceNumber}</option>)}</select></label>{selected&&<p className="screenshot-summary">{vendorLabel(selected.vendor)} · {selected.invoiceNumber}<br/>{selected.accountName} · {selected.date} · {selected.currency} {selected.amount}</p>}<button className="button secondary" disabled={busy||!selected} onClick={()=>void run('attach')}>确认归档</button></details>}
    {canResolve&&<div className="screenshot-item-actions">{['failed','interrupted','needs_review'].includes(item.status)&&<button className="text-button" disabled={busy} onClick={()=>void run('retry')}>{item.status==='needs_review'?'重新匹配':'重试识别'}</button>}{item.status!=='ignored'&&<button className="text-button" disabled={busy} onClick={()=>void run('ignore')}>忽略</button>}</div>}
    {error&&<p className="feedback error" role="alert">{error}</p>}
  </article>;
}
