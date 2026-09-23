import type {Job} from './Automation';
import type {Material,RecordItem} from './types';
import {batchAmounts} from './claim-batches.ts';

const names=(records:RecordItem[])=>records.map(r=>`${r.billingMonth}（${r.invoiceNumber||r.id}）`).join('、');
export function batchPDFReason(records:RecordItem[],purpose:string,sourceIDs:string[],evidence:Material[]){
  const reasons:string[]=[];
  const amounts=batchAmounts(records),unverified=records.filter(r=>!r.paymentVerified);
  if(records.length<2)reasons.push('至少选择 2 笔费用才能合并。');
  if(unverified.length)reasons.push(`${names(unverified)}的付款尚未核验，请到对应费用的“实付款”步骤核验。`);
  if(amounts.total===null)reasons.push('部分费用缺少有效汇率或金额，请补齐发票日汇率并核对金额。');
  if(amounts.overLimit)reasons.push('合计超过 ¥4,000.00，请减少合并费用。');
  if(!purpose.trim())reasons.push('请先填写共同科研用途说明，或采用下方的 DeepSeek 草稿。');
  if(sourceIDs.some(id=>!evidence.some(m=>m.id===id&&m.integrity==='ok')))reasons.push('勾选的科研截图已缺失或变化，请取消勾选或重新上传。');
  return reasons.join(' ');
}
export function batchAdoptionReason(job:Job|undefined,version:string|undefined,text:string,overwrite:boolean){
  if(overwrite)return '共同说明或截图有未保存的修改，请保存并重新整理，避免旧草稿覆盖修改。';
  if(!version)return '请先保存共同说明，再整理并采用草稿。';
  if(!job||job.kind!=='batch-purpose')return '尚无可采用的共同说明草稿，请先使用 DeepSeek 整理说明。';
  if(job.status==='queued'||job.status==='running')return 'DeepSeek 正在整理，请等待草稿生成。';
  if(job.status==='failed'||job.status==='interrupted')return '此次整理失败或已中断，请查看任务提示后重新整理。';
  if(job.current===false||job.status==='stale'||job.sourceBatchVersion!==version)return '草稿对应的说明或截图已变化，请重新整理后再采用。';
  if(job.status!=='completed'||job.current!==true)return '尚未确认草稿是当前版本，请刷新状态后再试。';
  if(!job.result?.purpose?.trim()||!text.trim())return '草稿为空，请填写草稿内容或重新整理。';
  return '';
}
