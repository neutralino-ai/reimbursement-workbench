import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import {AuthenticatedFileLink} from './AuthenticatedFiles';
import type { Material, RecordItem, Workspace } from './types';

type PendingFile = {id:string; file:File};
function PendingPreview({file}: {file:File}) {
  const [url,setURL]=useState('');
  useEffect(()=>{
    if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))return;
    const value=URL.createObjectURL(file);setURL(value);
    return ()=>URL.revokeObjectURL(value);
  },[file]);
  return url?<img className="material-pending-preview" src={url} alt={file.name+' 上传前预览'}/>:null;
}

export default function MaterialUpload({record,role,onReload,onBusy,onPending,disabled=false}: {
  record:RecordItem;
  role:'invoice'|'payment'|'purposeEvidence';
  onReload:()=>Promise<Workspace>;
  onBusy:(value:boolean)=>void;
  onPending?:(value:boolean)=>void;
  disabled?:boolean;
}) {
  const input=useRef<HTMLInputElement>(null),lock=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [pending,setPending]=useState<PendingFile[]>([]),[confirmID,setConfirmID]=useState('');
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
  function setWorking(value:boolean){lock.current=value;setBusy(value);onBusy(value);}
  async function upload() {
    if(lock.current||disabled||!record.version||!pending.length)return;
    setWorking(true);setError('');setSuccess('');let saved=0;
    let version=record.version;
    try {
      for(const item of pending) {
        const contentBase64=await new Promise<string>((resolve,reject)=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(String(reader.result).split(',')[1]);
          reader.onerror=()=>reject(new Error('无法读取文件，请重新选择。'));
          reader.readAsDataURL(item.file);
        });
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
      try {await onReload();}catch {setError(previous=>(previous+' 台账刷新失败，请刷新后查看；已成功上传的文件不会重复提交。').trim());}
      setWorking(false);
    }
  }
  async function remove(material:Material) {
    if(lock.current||disabled||!record.version)return;
    setWorking(true);setError('');setSuccess('');let removed=false;
    try {
      await api('/api/records/'+encodeURIComponent(record.id)+'/materials/'+encodeURIComponent(material.id),{
        method:'DELETE',body:JSON.stringify({baseVersion:record.version}),
      });
      removed=true;setConfirmID('');
      await onReload();setSuccess('已删除 '+material.filename+'。');
    }catch(failure){setError(removed?'附件已删除，台账刷新失败。请刷新后核对。':failure instanceof Error?failure.message:'删除失败。');}
    finally{setWorking(false);}
  }
  return <div className="material-upload">
    <input className="sr-only" ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic" aria-label={'选择'+label} onChange={event=>choose(event.target.files)} disabled={busy||disabled}/>
    <button type="button" className="button secondary" disabled={busy||disabled||!record.version} onClick={()=>input.current?.click()}>选择{label}</button>
    <p>选择文件后可移除选错的图片，点击“提交上传”才会保存。</p>
    {pending.length>0&&<div className="material-pending-list" aria-label="待上传附件">
      {pending.map(item=><div className="material-pending" key={item.id}><PendingPreview file={item.file}/><span title={item.file.name}>{item.file.name}</span><button type="button" className="text-button danger-text" aria-label={'移除待上传的 '+item.file.name} disabled={busy} onClick={()=>setPending(previous=>previous.filter(file=>file.id!==item.id))}>移除</button></div>)}
      <div className="material-upload-actions"><button type="button" className="text-button" disabled={busy} onClick={()=>setPending([])}>取消上传</button><button type="button" className="button primary small" disabled={busy||disabled||!record.version} onClick={()=>void upload()}>{busy?'上传中…':'提交上传（'+pending.length+'）'}</button></div>
    </div>}
    {existing.length>0&&<div className="material-upload-list"><small>已上传附件：</small>{existing.map(material=><div key={material.id}>
      <div className="material-upload-item"><AuthenticatedFileLink href={material.href} filename={material.filename}>{material.filename}</AuthenticatedFileLink><button type="button" className="text-button danger-text" aria-label={'删除 '+material.filename} disabled={busy||disabled||!record.version} onClick={()=>setConfirmID(material.id)}>删除</button></div>
      {confirmID===material.id&&<div className="inline-confirm"><span>删除“{material.filename}”？已生成的相关草稿需重新生成。</span><button type="button" className="text-button" disabled={busy} onClick={()=>setConfirmID('')}>取消</button><button type="button" className="button danger small" disabled={busy||disabled} onClick={()=>void remove(material)}>确认删除</button></div>}
    </div>)}</div>}
    {error&&<p className="feedback error" role="alert">{error}</p>}
    {success&&<p className="feedback success" role="status">{success}</p>}
  </div>;
}
