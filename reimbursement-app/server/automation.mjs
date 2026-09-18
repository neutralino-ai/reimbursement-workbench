import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {extractPayment,comparePayment} from './payment-precheck.mjs';
import {deepseek,extractInvoice,compareInvoice,draftPurpose} from './deepseek.mjs';
import {documentTool} from './document-runtime.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(message,code=400)=>{throw Object.assign(new Error(message),{statusCode:code});};
const now=()=>new Date().toISOString();
const finishedFinance=r=>r.priorStepsComplete||r.financeReviewPending||r.status==='completed';
const originals=r=>r.materials.filter(m=>['invoice','payment'].includes(m.role)).map(m=>({id:m.id,role:m.role,sha256:m.sha256,integrity:m.integrity})).sort((a,b)=>a.id.localeCompare(b.id));
export const reviewFingerprint=r=>hash({invoice:r.invoiceNumber,date:r.date,amount:r.amount,currency:r.currency,account:r.accountID,materials:originals(r)});
const atomic=(filename,value)=>{const temp=filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,filename);};
const readJSON=(filename,fallback)=>fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):fallback;

export function createAutomation({store,dataDir,fetchImpl=fetch,render=documentTool,intervalMs=5000,start=true}){
  const directory=path.join(dataDir,'automation');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const keyFile=path.join(directory,'master.key'),settingsFile=path.join(directory,'settings.json'),stateFile=path.join(directory,'jobs.json');
  if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});
  const master=fs.readFileSync(keyFile);if(master.length!==32)throw new Error('AI 设置加密密钥无效');
  let settings=readJSON(settingsFile,{enabled:false,revision:'new',encryptedKey:null,lastTest:null});
  const state=readJSON(stateFile,{jobs:[],purposes:{},operations:{}});
  let running=false,closed=false,timer;
  for(const job of state.jobs)if(job.status==='running'){job.status='interrupted';job.error='服务重启中断了任务，请手动重试；未自动重复调用模型。';}
  const persist=()=>atomic(stateFile,state);persist();
  function secret(){if(!settings.encryptedKey)return '';const {iv,tag,data}=settings.encryptedKey;const decipher=createDecipheriv('aes-256-gcm',master,Buffer.from(iv,'hex'));decipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8');}
  function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')};}
  const publicSettings=()=>({configured:!!settings.encryptedKey,enabled:settings.enabled,model:'deepseek-flash',keyHint:settings.keyHint||'',revision:settings.revision,lastTest:settings.lastTest||null});
  const record=id=>{const r=store.workspace().records.find(r=>r.id===id);if(!r)fail('费用记录不存在。',404);return r;};
  const checkVersion=(actual,expected)=>{if(!expected||actual!==expected)fail('内容已变化，请刷新后重试。',409);};
  const command=(type,payload,baseVersion,operationId)=>store.executeAgentCommand({type,operationId,baseVersion,payload,actor:{type:'agent',id:'deepseek-worker'}}).data;
  function once(input,action){
    if(typeof input.operationId!=='string'||!input.operationId||input.operationId.length>160)fail('缺少有效 operationId。');
    const digest=hash(input),previous=state.operations[input.operationId];
    if(previous){if(previous.digest!==digest)fail('operationId 已用于不同操作。',409);return previous.result;}
    const result=action();state.operations[input.operationId]={digest,result};persist();return result;
  }
  function saveSettings(input){
    checkVersion(settings.revision,input.baseVersion);
    if(typeof input.enabled!=='boolean')fail('自动核验开关无效。');
    const newKey=input.apiKey?.trim();
    if(newKey&&(!/^sk-[A-Za-z0-9_-]{12,180}$/.test(newKey)))fail('DeepSeek API 密钥格式无效。');
    const next={...settings};
    if(input.clearKey===true){next.encryptedKey=null;next.keyHint='';next.lastTest=null;}
    else if(newKey){next.encryptedKey=encrypt(newKey);next.keyHint='••••'+newKey.slice(-4);next.lastTest=null;}
    if(input.enabled&&!next.encryptedKey)fail('启用前请先保存 API 密钥。');
    settings={...next,enabled:input.enabled,revision:randomUUID(),updatedAt:now()};atomic(settingsFile,settings);if(start)void tick().catch(()=>{});return publicSettings();
  }
  let testing=false;
  async function testSettings(input){
    if(testing)fail('连接测试正在进行，请稍候。',409);
    const apiKey=input.apiKey?.trim()||secret();if(!apiKey||!/^sk-[A-Za-z0-9_-]{12,180}$/.test(apiKey))fail('请填写有效 DeepSeek API 密钥。');
    testing=true;const revision=settings.revision,startTime=Date.now();
    try{const response=await deepseek({apiKey,fetchImpl,instructions:'Reply with OK only.',input:'Connection test',maxTokens:24});const result={ok:true,at:now(),model:response.model,elapsedMs:Date.now()-startTime};if(!input.apiKey&&revision===settings.revision){settings.lastTest=result;atomic(settingsFile,settings);}return result;}
    finally{testing=false;}
  }
  function addJob(kind,input,extra={}){
    const job={id:randomUUID(),kind,status:'queued',createdAt:now(),...extra,input};state.jobs.push(job);persist();if(start)queueMicrotask(()=>void tick().catch(()=>{}));return publicJob(job);
  }
  function publicJob(job){
    const {input,...view}=job;
    let current=job.recordID?job.fingerprint===reviewFingerprint(record(job.recordID)):true;
    if(job.kind==='packet'&&job.result?.documentID){
      const document=store.workspace().documents.find(d=>d.id===job.result.documentID);
      current=current&&!!document&&!document.stale&&state.purposes[job.recordID]?.version===input.purposeVersion;
    }
    if(job.kind==='zip'&&job.status==='completed'){
      const docs=store.workspace().documents;
      current=!!job.result?.documentVersions&&input.documentIDs.every(id=>docs.some(d=>d.id===id&&d.ready&&!d.stale&&d.version===job.result.documentVersions[id]));
    }
    return {...view,current,...(!current&&job.status==='completed'?{status:'stale'}:{})};
  }
  function status(){return {settings:publicSettings(),jobs:state.jobs.slice(-100).reverse().map(publicJob),purposes:structuredClone(state.purposes)};}
  function decorate(workspace){
    for(const r of workspace.records){const last=[...state.jobs].reverse().find(j=>j.kind==='review'&&j.recordID===r.id);if(last)r.aiReview={id:last.id,status:last.fingerprint===reviewFingerprint(r)?last.status:'stale',at:last.finishedAt||last.createdAt,reasons:last.result?.reasons||[],error:last.error||''};}
    return workspace;
  }
  function enqueueReview(input){return once(input,()=>{
    const r=record(input.recordID);checkVersion(r.version,input.baseVersion);if(finishedFinance(r))fail('此费用已进入财务审核，无需重核前序材料。');
    if(!settings.enabled||!settings.encryptedKey)fail('请先启用 DeepSeek 自动核验。');
    const fingerprint=reviewFingerprint(r);
    const active=state.jobs.find(j=>j.kind==='review'&&j.recordID===r.id&&j.fingerprint===fingerprint&&['queued','running'].includes(j.status));if(active)return publicJob(active);
    return addJob('review',{recordVersion:r.version,materialIDs:input.materialIDs||[]},{recordID:r.id,fingerprint});
  });}
  function savePurpose(input){return once(input,()=>{
    const r=record(input.recordID);checkVersion(r.version,input.recordVersion);const old=state.purposes[r.id];checkVersion(old?.version||'new',input.baseVersion);
    if(typeof input.text!=='string'||input.text.length>6000||!Array.isArray(input.sourceMaterialIDs)||input.sourceMaterialIDs.length>5)fail('用途须在 6000 字以内，最多五份用途附件。');
    for(const id of input.sourceMaterialIDs){const material=r.materials.find(m=>m.id===id&&m.role==='purposeEvidence'&&m.integrity==='ok');if(!material)fail('用途附件须为本条费用已保存的原始材料。');store.material(id);}
    command('record.patch',{recordID:r.id,paymentVerified:r.paymentVerified,evidenceIDs:r.materials.filter(m=>m.integrity==='ok').map(m=>m.id),note:'用途原文或用途附件已更新，先前申报文件需按新用途重新生成。'},r.version,input.operationId+':purpose');
    const value={recordID:r.id,version:randomUUID(),text:input.text.trim(),sourceMaterialIDs:[...new Set(input.sourceMaterialIDs)],draft:'',missing:[],updatedAt:now()};state.purposes[r.id]=value;return value;
  });}
  function enqueuePurpose(input){return once(input,()=>{
    const r=record(input.recordID),purpose=state.purposes[r.id];checkVersion(purpose?.version,input.purposeVersion);
    if(!purpose.text&&!purpose.sourceMaterialIDs.length)fail('请先填写用途或上传用途截图。');if(!settings.encryptedKey)fail('请先配置 API 密钥。');
    return addJob('purpose',{purposeVersion:purpose.version},{recordID:r.id,fingerprint:reviewFingerprint(r)});
  });}
  function enqueuePacket(input){return once(input,()=>{
    const r=record(input.recordID);checkVersion(r.version,input.baseVersion);
    if(finishedFinance(r))fail('此费用已进入财务审核，无需重建材料。');
    if(!r.paymentVerified)fail('发票与付款尚未核验通过。');
    const purpose=state.purposes[r.id];checkVersion(purpose?.version,input.purposeVersion);
    if(typeof input.purpose!=='string'||!input.purpose.trim()||input.purpose.length>6000||input.confirmed!==true)fail('请检查并确认用途说明后生成。');
    const expected=r.currency==='CNY'?r.amount:r.exchangeRate?.valid?r.exchangeRate.cnyAmount:null;
    if(!expected)fail('缺少有效的发票日中行折算价或官网截图。');
    if(input.claimedCNY!==expected)fail('确认金额与当前汇率换算不符，请刷新。',409);
    if((r.claimConfirmed||r.submissionReference||Number(r.approvedCNY)>0)&&r.claimedCNY!==expected)fail('已有申报金额与换算金额不同，保留历史金额，请先核对。',409);
    const updated=command('record.patch',{recordID:r.id,claimedCNY:expected,claimConfirmed:true,evidenceIDs:r.materials.filter(m=>['invoice','payment','exchangeRate'].includes(m.role)&&m.integrity==='ok').map(m=>m.id),note:'按客户端明确确认的用途和发票日汇率生成申报草稿；不代表已交财务。'},r.version,input.operationId+':claim');
    const finalPurpose={...purpose,confirmedText:input.purpose.trim(),confirmedAt:now(),version:randomUUID()};state.purposes[r.id]=finalPurpose;
    return addJob('packet',{recordVersion:updated.version,purposeVersion:finalPurpose.version,purpose:finalPurpose.confirmedText},{recordID:r.id,fingerprint:reviewFingerprint(updated)});
  });}
  function approvePacket(input){return once(input,()=>{
    const job=state.jobs.find(j=>j.id===input.jobID&&j.kind==='packet'&&j.status==='completed');if(!job)fail('申报草稿不存在。');
    if(input.confirmed!==true)fail('请先检查 PDF 内容与附件。');
    const workspace=store.workspace(),document=workspace.documents.find(d=>d.id===job.result.documentID),r=record(job.recordID);
    if(!document||document.stale||document.sourceRecords[0].version!==r.version)fail('草稿来源已变化，请重新生成。',409);
    const result=command('document.register',{id:document.id,title:document.title,purpose:'application',materialIDs:document.materialIDs,submissionPDFMaterialID:document.submissionPDFMaterialID,recordIDs:[r.id],sourceRecordVersions:{[r.id]:r.version},sourceMaterialIDs:document.sourceMaterialIDs,status:'ready',note:'用户在客户端检查了生成的整合 PDF 与附件，确认材料已备妥。'},document.version,input.operationId+':ready');
    job.result.approved=true;return result;
  });}
  function enqueueZip(input){return once(input,()=>{
    if(!Array.isArray(input.documentIDs)||!input.documentIDs.length||input.documentIDs.length>30||new Set(input.documentIDs).size!==input.documentIDs.length)fail('请选择 1–30 份不同的已备妥材料。');
    const docs=store.workspace().documents;for(const id of input.documentIDs)if(!docs.find(d=>d.id===id&&d.ready&&!d.stale))fail('所选材料尚未备妥或已过期。',409);
    return addJob('zip',{documentIDs:input.documentIDs});
  });}
  async function images(materialID,folder){const file=store.material(materialID);const prepared=await render('images',{path:file.path},folder);return prepared.images.map(p=>fs.readFileSync(p));}
  async function review(job){
    const r=record(job.recordID);checkVersion(r.version,job.input.recordVersion);
    const eligible=r.materials.filter(m=>m.integrity==='ok'&&(!job.input.materialIDs.length||job.input.materialIDs.includes(m.id)));
    const invoices=eligible.filter(m=>m.role==='invoice'),payments=eligible.filter(m=>m.role==='payment');
    if(invoices.length!==1||payments.length!==1){job.status='needs_review';job.result={reasons:['请选定一份发票及一份付款凭证后重新核验。']};return;}
    const work=path.join(directory,'work',job.id),apiKey=secret();
    const invoice=await extractInvoice({apiKey,fetchImpl,images:await images(invoices[0].id,path.join(work,'invoice'))});
    const paymentImages=await images(payments[0].id,path.join(work,'payment'));
    if(paymentImages.length!==1){job.status='needs_review';job.result={reasons:['付款文件有多页，请提供明确的单笔交易截图。']};return;}
    const payment=await extractPayment({apiKey,fetchImpl,bytes:paymentImages[0]});
    const duplicateImage=store.workspace().records.some(other=>other.id!==r.id&&other.materials.some(m=>m.role==='payment'&&m.sha256===payments[0].sha256));
    const invoiceCheck=compareInvoice(invoice.data,r),paymentCheck=comparePayment(payment.extraction,r,{duplicateImage});
    const checks=[invoiceCheck,paymentCheck];job.result={invoice,payment,invoiceCheck,paymentCheck,sourceMaterialIDs:[invoices[0].id,payments[0].id],sourceHashes:[invoices[0].sha256,payments[0].sha256],reasons:checks.flatMap(c=>c.reasons||[]),humanVerified:false};
    const current=record(r.id);if(current.version!==r.version||reviewFingerprint(current)!==job.fingerprint){job.status='stale';job.error='核验期间材料或费用记录已变化，结果未写回。';return;}
    job.status=checks.some(c=>c.status==='mismatch')?'mismatch':checks.some(c=>c.status==='needs_review')?'needs_review':'matched';
    if(job.status==='matched'&&!current.paymentVerified){command('record.patch',{recordID:r.id,paymentVerified:true,evidenceIDs:job.result.sourceMaterialIDs,note:`DeepSeek 自动核验 ${job.id}：发票身份及付款商户、金额、币种、日期、结算状态匹配；原件 SHA256 已留存。不代替人工核验。`},current.version,job.id+':payment');job.applied=true;}
  }
  async function purposeJob(job){
    const p=state.purposes[job.recordID];checkVersion(p.version,job.input.purposeVersion);
    const pictures=[];for(const [i,id]of p.sourceMaterialIDs.entries())pictures.push(...await images(id,path.join(directory,'work',job.id,String(i))));
    if(pictures.length>12)fail('用途附件页数超过 12 页，请精简。');
    const result=await draftPurpose({apiKey:secret(),fetchImpl,text:p.text,images:pictures});
    if(state.purposes[job.recordID].version!==p.version){job.status='stale';return;}
    state.purposes[job.recordID]={...p,version:randomUUID(),draft:result.data.purpose,missing:result.data.missing,model:result.model,usage:result.usage,updatedAt:now()};job.result=result;job.status='completed';
  }
  function importOutput(job,filename,role){return command('material.import',{filename:path.basename(filename),role,contentBase64:fs.readFileSync(filename).toString('base64'),source:{kind:'generated',capturedAt:now(),note:`服务器生成；任务 ${job.id}。`}},undefined,job.id+':'+path.basename(filename));}
  async function packet(job){
    const r=record(job.recordID);checkVersion(r.version,job.input.recordVersion);checkVersion(state.purposes[r.id].version,job.input.purposeVersion);
    const reviewJob=[...state.jobs].reverse().find(j=>j.kind==='review'&&j.recordID===r.id&&j.status==='matched'&&j.fingerprint===reviewFingerprint(r));
    const select=role=>{const all=r.materials.filter(m=>m.role===role&&m.integrity==='ok');const selected=all.filter(m=>reviewJob?.result?.sourceMaterialIDs?.includes(m.id));if(selected.length===1)return selected;if(all.length===1)return all;fail('请先选定明确的发票和付款原件进行核验。');};
    const sourceMaterials=[...select('invoice'),...select('payment'),...(r.currency==='CNY'?[]:(r.exchangeRate?.evidenceIDs||[]).map(id=>r.materials.find(m=>m.id===id))),...state.purposes[r.id].sourceMaterialIDs.map(id=>r.materials.find(m=>m.id===id))];
    if(sourceMaterials.some(m=>!m||m.integrity!=='ok'))fail('申报原件缺失或已变化。');
    const sources=sourceMaterials.map(m=>({...m,path:store.material(m.id).path}));
    const result=await render('packet',{record:r,purpose:job.input.purpose,sources},path.join(directory,'work',job.id));
    if(record(r.id).version!==r.version||state.purposes[r.id].version!==job.input.purposeVersion){job.status='stale';job.error='生成期间内容已修改，请重建材料。';return;}
    const pdf=importOutput(job,result.pdf,'document'),docx=importOutput(job,result.docx,'statement');
    const policyIDs=(store.workspace().policies||[]).filter(p=>p.status==='active'&&p.integrity==='ok').map(p=>p.materialID);
    const document=command('document.register',{id:'generated:'+job.id,title:`${r.billingMonth} ${r.invoiceNumber} 申报材料`,purpose:'application',materialIDs:[pdf.id,docx.id],submissionPDFMaterialID:pdf.id,recordIDs:[r.id],sourceRecordVersions:{[r.id]:r.version},sourceMaterialIDs:[...new Set([...sourceMaterials.map(m=>m.id),...policyIDs])],status:'draft',note:`模板 ${result.templateVersion}；中文字体嵌入、全部页渲染和原件哈希校验通过。附件页码：${JSON.stringify(result.sourcePageMap)}。等待用户检查 PDF。`},'new',job.id+':document');
    job.status='completed';job.result={documentID:document.id,pdfMaterialID:pdf.id,docxMaterialID:docx.id,pages:result.pages,fontEmbedded:result.fontEmbedded,sourcePageMap:result.sourcePageMap,approved:false};
  }
  async function zip(job){
    const docs=store.workspace().documents,selected=job.input.documentIDs.map(id=>docs.find(d=>d.id===id&&d.ready&&!d.stale));if(selected.some(d=>!d))fail('所选材料已过期，请重新生成。',409);
    const files=selected.map(d=>{const m=d.materials.find(m=>m.id===d.submissionPDFMaterialID),r=record(d.recordIDs[0]);return {path:store.material(m.id).path,sha256:m.sha256,name:`${r.billingMonth}-${r.invoiceNumber}.pdf`};});
    const result=await render('zip',{files},path.join(directory,'work',job.id));
    const refreshed=store.workspace().documents;for(const d of selected)if(!refreshed.find(x=>x.id===d.id&&x.ready&&!x.stale&&x.version===d.version))fail('打包期间材料已变化，请重新打包。',409);
    const material=importOutput(job,result.zip,'document');job.status='completed';job.result={materialID:material.id,files:files.length,documentVersions:Object.fromEntries(selected.map(d=>[d.id,d.version]))};
  }
  function scan(){
    if(!settings.enabled||!settings.encryptedKey)return;
    for(const r of store.workspace().records){
      if(r.vendor!=='chatgpt'||finishedFinance(r))continue;
      const fingerprint=reviewFingerprint(r),previous=[...state.jobs].reverse().find(j=>j.kind==='review'&&j.recordID===r.id);
      if(state.jobs.some(j=>j.kind==='review'&&j.recordID===r.id&&j.fingerprint===fingerprint))continue;
      if(previous?.applied&&r.paymentVerified&&previous.fingerprint!==fingerprint){command('record.patch',{recordID:r.id,paymentVerified:false,evidenceIDs:r.materials.filter(m=>m.integrity==='ok'&&['invoice','payment'].includes(m.role)).map(m=>m.id),note:'自动核验所依据的原件已改变，撤回旧的自动付款结论，等待重新核验。'},r.version,'invalidate:'+fingerprint);}
      else if(r.paymentVerified&&!previous)continue;
      if(!r.materials.some(m=>m.role==='invoice'&&m.integrity==='ok')||!r.materials.some(m=>m.role==='payment'&&m.integrity==='ok'))continue;
      const fresh=record(r.id);addJob('review',{recordVersion:fresh.version,materialIDs:[]},{recordID:r.id,fingerprint});
    }
  }
  async function tick(){
    if(running||closed)return;running=true;
    try{
      scan();let job;
      while(!closed&&(job=state.jobs.find(j=>j.status==='queued'))){
        job.status='running';job.startedAt=now();persist();
        try{if(['review','purpose'].includes(job.kind)&&!settings.encryptedKey)fail('API 密钥尚未配置。');await ({review,purpose:purposeJob,packet,zip}[job.kind])(job);}
        catch(error){job.status=error.statusCode===409?'stale':'failed';job.error=String(error.message).replaceAll(secret()||'__no_key__','[redacted]').slice(0,600);}
        job.finishedAt=now();persist();
      }
    }finally{running=false;}
  }
  if(start){timer=setInterval(()=>void tick().catch(()=>{}),intervalMs);timer.unref();queueMicrotask(()=>void tick().catch(()=>{}));}
  async function close(){closed=true;if(timer)clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,25));}
  return {status,decorate,saveSettings,testSettings,enqueueReview,savePurpose,enqueuePurpose,enqueuePacket,approvePacket,enqueueZip,tick,close};
}
