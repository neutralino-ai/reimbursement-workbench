import {useEffect,useRef,useState,type Ref} from 'react';
import type {RecordItem,Workspace} from './types';
import type {AutomationState} from './Automation';
import {api} from './api';
import MaterialUpload from './MaterialUpload';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import ActionButton from './ActionButton';
import {currentSupplementReview,supplementReadyReason} from './invoice-supplement';

type Props={records:RecordItem[];batchID?:string;baseVersion?:string;state:AutomationState|null;value:string;onSelection:(id:string)=>void;onReload:()=>Promise<unknown>;onRefresh:()=>Promise<unknown>;onBusy:(busy:boolean)=>void;onPending:(pending:boolean)=>void;disabled:boolean;locked?:boolean;panelRef?:Ref<HTMLElement>};
export default function InvoiceSupplement({records,batchID,baseVersion,state,value,onSelection,onReload,onRefresh,onBusy,onPending,disabled,locked,panelRef}:Props){
  const target=records.find(r=>r.invoiceRecipient?.requiresSignedSupplement||r.invoiceRecipient?.recipientKind==='non_ihep');
  const supplements=[...new Map(records.flatMap(r=>r.materials.filter(m=>m.role==='invoiceSupplement'&&m.integrity==='ok')).map(m=>[m.id,m])).values()];
  const [error,setError]=useState(''),[retrying,setRetrying]=useState(false),operation=useRef<{key:string;id:string}|null>(null);
  useEffect(()=>{if(!value&&supplements.length===1)onSelection(supplements[0].id);else if(value&&!supplements.some(m=>m.id===value))onSelection('');},[value,supplements.map(m=>m.id).join('|'),onSelection]);
  if(!target)return null;
  const review=currentSupplementReview(state?.jobs||[],value,batchID,target.id),reason=supplementReadyReason(review,value),running=review?.status==='queued'||review?.status==='running';
  async function retry(){setRetrying(true);onBusy(true);setError('');const key=[batchID||target!.id,value,baseVersion||target!.version].join(':');if(operation.current?.key!==key)operation.current={key,id:crypto.randomUUID()};try{await api('/api/automation/review-supplement',{method:'POST',body:JSON.stringify({operationId:operation.current.id,materialID:value,...(batchID?{batchID,baseVersion}:{recordID:target!.id,baseVersion:target!.version})})});operation.current=null;await onRefresh();}catch(e){setError(e instanceof Error?e.message:'重新核查失败');}finally{setRetrying(false);onBusy(false);}}
  return <section ref={panelRef} tabIndex={-1} className="ai-recipient-supplement" aria-label="非单位抬头情况说明"><h3>报销人 / 地址非单位的情况说明</h3><p className="form-hint">每份报销材料上传一份已有的领导签字说明。上传后服务器自动调用 DeepSeek 核查签字、非单位抬头原因及本包发票覆盖范围，通过后作为独立附件随 ZIP 提交。</p>
    {!locked&&<MaterialUpload record={target} role="invoiceSupplement" onBusy={onBusy} onPending={onPending} disabled={disabled||retrying} onReload={async()=>{const next=await api<Workspace>('/api/workspace');const added=next.records.filter(r=>records.some(old=>old.id===r.id)).flatMap(r=>r.materials.filter(m=>m.role==='invoiceSupplement'&&m.integrity==='ok'&&!supplements.some(old=>old.id===m.id)));if(added.length===1)onSelection(added[0].id);await onReload();await onRefresh();return next;}}/>}
    {supplements.length>0&&<label>选择本份材料的签字说明<select value={value} onChange={e=>onSelection(e.target.value)} disabled={disabled||retrying}><option value="">请选择签字件</option>{supplements.map(m=><option key={m.id} value={m.id}>{m.filename}</option>)}</select></label>}
    {value&&<><AuthenticatedFileLink className="text-button" href={'/api/materials/'+encodeURIComponent(value)}>查看所选签字件</AuthenticatedFileLink><div className="ai-job" role="status"><strong>{!reason?'DeepSeek 核查通过':running?'DeepSeek 正在核查签字说明':review?'签字说明需处理':'等待服务器自动核查'}</strong><p>{reason||'已核查可见领导签字、非单位抬头原因及本包相关发票。'}</p>{!state?.settings.enabled&&<p>请在 AI 设置中启用 DeepSeek 自动核查。</p>}{!locked&&<ActionButton className="button secondary small" reason={disabled||retrying?'正在处理附件，请稍候。':running?'正在核查，请等待完成。':!state?.settings.enabled?'请先启用 DeepSeek 自动核查。':''} onClick={()=>void retry()}>重新核查</ActionButton>}</div></>}
    {error&&<p role="alert" className="feedback error">{error}</p>}
  </section>;
}
