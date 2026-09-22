export const vendorLabel=(vendor:string)=>vendor==='claude'?'Claude':vendor==='chatgpt'?'ChatGPT':vendor||'订阅服务';
export default function VendorBadge({vendor}:{vendor:string}){
  return <div className={`vendor-badge ${vendor==='claude'?'is-claude':vendor==='chatgpt'?'is-gpt':''}`} title={vendor==='claude'?'Anthropic / Claude':vendor==='chatgpt'?'OpenAI / ChatGPT':vendor}><span aria-hidden="true">{vendor==='claude'?'C':vendor==='chatgpt'?'G':'·'}</span><strong>{vendorLabel(vendor)}</strong></div>;
}
