import type {Job} from './Automation';

export function canAdoptBatchPurpose(job:Job|undefined,version:string|undefined,blocked:boolean){
  return !blocked&&!!version&&job?.kind==='batch-purpose'&&job.status==='completed'&&job.current===true
    &&job.sourceBatchVersion===version&&!!job.result?.purpose?.trim();
}

export function batchPurposeLabel(job:Job){
  if(job.current===false||job.status==='stale')return '用途或截图已变化，请重新整理';
  return ({queued:'DeepSeek 整理排队中',running:'DeepSeek 正在整理共同说明',completed:'DeepSeek 草稿已生成',failed:'DeepSeek 整理失败',interrupted:'整理已中断，可手动重试'} as Record<string,string>)[job.status]||'用途整理待检查';
}
