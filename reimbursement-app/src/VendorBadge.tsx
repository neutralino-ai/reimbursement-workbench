import {purchaseTypeLabel} from './purchase-type';
export const vendorLabel=(vendor:string)=>vendor==='claude'?'Claude':vendor==='chatgpt'?'ChatGPT':vendor||'订阅服务';
export default function VendorBadge({vendor,plan}:{vendor:string;plan?:string}){
  return <div className={`vendor-badge ${vendor==='claude'?'is-claude':vendor==='chatgpt'?'is-gpt':''}`} title={`${vendor==='claude'?'Anthropic / Claude':vendor==='chatgpt'?'OpenAI / ChatGPT':vendor} · ${plan||'项目待确认'}`}><span aria-hidden="true">{vendor==='claude'?'C':vendor==='chatgpt'?'G':'·'}</span><div className="vendor-wordmark"><strong>{vendorLabel(vendor)}</strong><small>{purchaseTypeLabel(plan)}</small></div></div>;
}
