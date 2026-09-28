import {useRef,useState} from 'react';
import {api,apiAddress} from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import {useAutomation,type Job} from './Automation';
import type {GeneratedDocument} from './types';

/** A ZIP is generated for exactly one checked combined application. */
export default function BatchZipAction({document}:{document:GeneratedDocument}){
  const {state,refresh,error:loadError}=useAutomation();
  const storageKey=`reimbursement-batch-zip:${apiAddress()}:${document.id}:${document.version||document.batchVersion||''}`;
  const [jobID,setJobID]=useState(()=>{try{return sessionStorage.getItem(storageKey)||'';}catch{return '';}});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pendingBody=useRef('');
  const job=state?.jobs.find(item=>item.id===jobID)||state?.jobs.find(item=>item.kind==='zip'&&item.status==='completed'&&!!document.version&&Object.keys(item.result?.documentVersions||{}).length===1&&item.result?.documentVersions?.[document.id]===document.version);
  async function build(){
    if(busy)return;
    setBusy(true);setError('');
    if(!pendingBody.current)pendingBody.current=JSON.stringify({documentIDs:[document.id],operationId:crypto.randomUUID()});
    try{
      const started=Date.now();
      const result=await api<Job|{job?:Job}>('/api/automation/zip',{method:'POST',body:pendingBody.current,signal:AbortSignal.timeout(30000)});
      pendingBody.current='';
      const next=await refresh();
      const id=('id' in result?result.id:result.job?.id)||next?.jobs.find(item=>item.kind==='zip'&&Date.parse(item.createdAt)>=started-2000)?.id;
      if(id){setJobID(id);try{sessionStorage.setItem(storageKey,id);}catch{/* Download remains available while this view is open. */}}
      else setError('打包任务已提交，但暂未取得任务编号。请刷新状态后查看主页面“申报 ZIP”。');
    }catch(failure){setError(failure instanceof Error?failure.message:'打包失败，请刷新状态后核对。');}
    finally{setBusy(false);}
  }
  return <span className="ov-batch-zip">
    {job?.status==='completed'&&job.current!==false&&job.result?.materialID?<AuthenticatedFileLink className="button primary small" href={'/api/materials/'+encodeURIComponent(job.result.materialID)} download="reimbursement-package.zip">下载申报 ZIP</AuthenticatedFileLink>:<button type="button" className="button primary small" disabled={busy||job?.status==='queued'||job?.status==='running'} onClick={()=>void build()}>{busy?'正在提交 ZIP 任务…':job?.status==='queued'?'ZIP 排队中':job?.status==='running'?'正在生成 ZIP':'生成申报 ZIP'}</button>}
    {job?.error&&<span className="feedback error" role="alert">{job.error}</span>}
    {(error||loadError)&&<span className="feedback error" role="alert">{error||loadError}</span>}
  </span>;
}
