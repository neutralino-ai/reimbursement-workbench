import type {Job} from './Automation';
export function currentSupplementReview(jobs:Job[],materialID:string,batchID?:string,recordID?:string){return jobs.find(j=>j.kind==='supplement-review'&&j.materialID===materialID&&(batchID?j.batchID===batchID:!j.batchID&&j.recordID===recordID));}
export function supplementReadyReason(job:Job|undefined,materialID:string){
  if(!materialID)return '请上传并选择本份材料的签字情况说明。';
  if(!job)return '签字说明等待服务器自动核查，请稍候。';
  if(job.current===false||job.status==='stale')return '签字说明或覆盖发票已变化，请重新核查。';
  if(job.status==='queued'||job.status==='running')return 'DeepSeek 正在核查签字说明，请等待完成。';
  if(job.status==='matched'&&job.current===true)return '';
  return job.error||job.result?.reasons?.join(' ')||'签字说明尚未通过 DeepSeek 核查，请查看提示并重新上传或核查。';
}
