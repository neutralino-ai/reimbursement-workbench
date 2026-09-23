import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import AttachmentPreview from './AttachmentPreview';
import ActionButton from './ActionButton';
import type { Material, RecordItem, Workspace } from './types';

type PendingFile = {id:string; file:File};

export default function MaterialUpload({record,role,onReload,onBusy,onPending,onActivity,disabled=false,disabledReason}: {
  record:RecordItem;
  role:'invoice'|'payment'|'purposeEvidence';
  onReload:()=>Promise<Workspace>;
  onBusy:(value:boolean)=>void;
  onPending?:(value:boolean)=>void;
  disabled?:boolean;
  disabledReason?:string;
  onActivity?:(value:string)=>void;
}) {
  const input=useRef<HTMLInputElement>(null),lock=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [pending,setPending]=useState<PendingFile[]>([]),[confirmID,setConfirmID]=useState('');
  const [activity,setActivity]=useState('');
  const label=role==='payment'?'付款截图或 PDF':role==='purposeEvidence'?'用途截图或 PDF':'发票 PDF 或图片';
  const existing=record.materials.filter(material=>material.role===role);
  useEffect(()=>{onPending?.(pending.length>0);},[pending.length,onPending]);
  useEffect(()=>()=>onPending?.(false),[onPending]);
  function choose(files:FileList|null) {
    if(lock.current||disabled)return;
    setError('');setSuccess('');
    const valid:PendingFile[]=[],errors:string[]=[];
    for(const file of Array.from(files||[])) {
      if(!file.size||file.size>20*1024*1024){errors.push(file.name+'：请选择 20 MB 以内的文件。');continue;}
      if(!/\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(file.name)){errors.push(file.name+'：请选择图片或 PDF。');continue;}
      valid.push({id:crypto.randomUUID(),file});
    }
    setPending(previous=>[...previous,...valid]);setError(errors.join(' '));
    if(input.current)input.current.value='';
  }
  function reportActivity(value:string){setActivity(value);onActivity?.(value);}
  function setWorking(value:boolean){lock.current=value;setBusy(value);onBusy(value);if(!value)reportActivity('');}
  async function upload() {
    if(lock.current||disabled||!record.version||!pending.length)return;
    setWorking(true);setError('');setSuccess('');let saved=0;
    let version=record.version;
    try {
      for(const item of pending) {
        reportActivity(`正在读取第 ${saved+1}/${pending.length} 份附件：${item.file.name}`);
        const contentBase64=await new Promise<string>((resolve,reject)=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(String(reader.result).split(',')[1]);
          reader.onerror=()=>reject(new Error('无法读取文件，请重新选择。'));
          reader.readAsDataURL(item.file);
        });
        reportActivity(`正在上传第 ${saved+1}/${pending.length} 份附件：${item.file.name}`);
        const result=await api<{recordVersion:string}>('/api/records/'+encodeURIComponent(record.id)+'/materials',{
          method:'POST',body:JSON.stringify({filename:item.file.name,role,contentBase64,baseVersion:version}),
        });
        saved++;version=result.recordVersion;
        setPending(previous=>previous.filter(file=>file.id!==item.id));
      }
      setSuccess('已上传 '+saved+' 份附件。');
    } catch(failure) {
      setError((saved?'已上传 '+saved+' 份；':'')+(failure instanceof Error?failure.message:'上传失败。')+' 剩余文件仍在待上传列表。');
    } finally {
      reportActivity('正在刷新附件列表');
      try {await onReload();}catch {setError(previous=>(previous+' 台账刷新失败，请刷新后查看；已成功上传的文件不会重复提交。').trim());}
      setWorking(false);
    }
  }
  async function remove(material:Material) {
    if(lock.current||disabled||!record.version)return;
    setWorking(true);setError('');setSuccess('');let removed=false;
    reportActivity('正在删除附件：'+material.filename);
    try {
      await api('/api/records/'+encodeURIComponent(record.id)+'/materials/'+encodeURIComponent(material.id),{
        method:'DELETE',body:JSON.stringify({baseVersion:record.version}),
      });
      removed=true;setConfirmID('');
      reportActivity('正在刷新附件列表');
      await onReload();setSuccess('已删除 '+material.filename+'。');
    }catch(failure){setError(removed?'附件已删除，台账刷新失败。请刷新后核对。':failure instanceof Error?failure.message:'删除失败。');}
    finally{setWorking(false);}
  }
  const busyReason=busy?(activity||'正在处理附件')+'，请稍候。':'';
  const actionReason=busyReason||(disabled?disabledReason||'当前正在处理其他操作，请完成后再试。':'')||(!record.version?'尚未读取到费用版本，请刷新页面后再操作。':'');
  return <div className="material-upload">
    <input className="sr-only" ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic" aria-label={'选择'+label} onChange={event=>choose(event.target.files)} disabled={busy||disabled}/>
    <ActionButton type="button" className="button secondary" reason={actionReason} onClick={()=>input.current?.click()}>选择{label}</ActionButton>
    <p>点击缩略图或文件名可预览。选择后可移除，点击“提交上传”才会保存。</p>
    {pending.length>0&&<div className="material-pending-list" aria-label="待上传附件">
      {pending.map(item=><div className="material-pending" key={item.id}><AttachmentPreview file={item.file}/><ActionButton type="button" className="text-button danger-text" aria-label={'移除待上传的 '+item.file.name} reason={busyReason} onClick={()=>setPending(previous=>previous.filter(file=>file.id!==item.id))}>移除</ActionButton></div>)}
      <div className="material-upload-actions"><ActionButton type="button" className="text-button" reason={busyReason} onClick={()=>setPending([])}>取消上传</ActionButton><ActionButton type="button" className="button primary small" reason={actionReason} onClick={()=>void upload()}>{busy?'上传中…':'提交上传（'+pending.length+'）'}</ActionButton></div>
    </div>}
    {existing.length>0&&<div className="material-upload-list"><small>已上传附件：</small>{existing.map(material=><div key={material.id}>
      <div className="material-upload-item"><AttachmentPreview href={material.href} filename={material.filename}/><ActionButton type="button" className="text-button danger-text" aria-label={'删除 '+material.filename} reason={actionReason} onClick={()=>setConfirmID(material.id)}>删除</ActionButton></div>
      {confirmID===material.id&&<div className="inline-confirm"><span>删除“{material.filename}”？已生成的相关草稿需重新生成。</span><ActionButton type="button" className="text-button" reason={busyReason} onClick={()=>setConfirmID('')}>取消</ActionButton><ActionButton type="button" className="button danger small" reason={busyReason||(disabled?disabledReason||'当前正在处理其他操作，请完成后再试。':'' )} onClick={()=>void remove(material)}>确认删除</ActionButton></div>}
    </div>)}</div>}
    {error&&<p className="feedback error" role="alert">{error}</p>}
    {success&&<p className="feedback success" role="status">{success}</p>}
  </div>;
}
