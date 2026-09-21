'use strict';
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const {createReadStream} = require('node:fs');
const path = require('node:path');
const REPOSITORY='neutralino-ai/reimbursement-workbench';
const RELEASES_URL=`https://github.com/${REPOSITORY}/releases`;
const MAX_ASSET=300*1024*1024;
const fail=message=>{throw Object.assign(new Error(message),{code:'UPDATE_FAILED'});};
function versionParts(value){const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value||'');return m?m.slice(1).map(BigInt):null;}
function newer(candidate,current){const a=versionParts(candidate),b=versionParts(current);if(!a||!b)throw new Error('版本号无效');for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
function releaseInfo(release,currentVersion,platform,arch){
  if(!versionParts(currentVersion))throw new Error('当前版本无效');
  if(!release||release.draft!==false||release.prerelease!==false||!versionParts(release.tag_name))fail('Release 不是有效的正式版本');
  const version=release.tag_name.replace(/^v/,'');
  const releaseUrl=`${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
  if(release.html_url!==releaseUrl)throw new Error('Release 地址不属于本项目');
  const suffix=platform==='win32'&&arch==='x64'?'win-x64.exe':platform==='darwin'&&['x64','arm64'].includes(arch)?`mac-${arch}.dmg`:null;
  const filename=suffix?`Reimbursement-${version}-${suffix}`:null;
  const expected=filename?`https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`:null;
  const candidates=Array.isArray(release.assets)?release.assets.filter(a=>a.name===filename):[];
  const candidate=candidates.length===1?candidates[0]:null;
  const asset=candidate&&candidate.state==='uploaded'&&Number.isSafeInteger(candidate.size)&&candidate.size>0&&candidate.size<=MAX_ASSET&&candidate.browser_download_url===expected&&/^sha256:[a-f0-9]{64}$/.test(candidate.digest||'')?candidate:null;
  const status=newer(version,currentVersion)?'available':newer(currentVersion,version)?'ahead':'current';
  return {status,currentVersion,latestVersion:version,releaseUrl,downloadUrl:asset?expected:null,assetName:asset?filename:null,assetSize:asset?.size||0,sha256:asset?.digest.slice(7)||null,publishedAt:release.published_at||null,notes:typeof release.body==='string'?release.body.slice(0,6000):'',message:status==='available'&&!asset?(suffix?'当前系统的安装包尚未就绪，可稍后重试。':'当前系统架构暂无安装包。'):''};
}
async function checkForUpdates({currentVersion,platform=process.platform,arch=process.arch,fetchImpl=fetch,signal}){
  let response;
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
  try {response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':`Reimbursement/${currentVersion}`},credentials:'omit',redirect:'error',signal:requestSignal});}
  catch {fail('无法连接 GitHub，请检查网络后重试');}
  if(response.status===404)return {status:'unavailable',currentVersion,releaseUrl:RELEASES_URL,message:'尚无公开的正式 Release，或仓库暂不可访问'};
  if(response.status===429||(response.status===403&&response.headers.get('x-ratelimit-remaining')==='0'))fail('GitHub 请求限额已用完，请稍后再试');
  if(!response.ok)fail(`GitHub 返回 HTTP ${response.status}，请稍后重试`);
  if(!response.body)fail('GitHub 返回了空的发布信息');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)fail('Release 信息过大');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  let release;try{release=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('无法读取 GitHub 发布信息，请重试');}
  return {...releaseInfo(release,currentVersion,platform,arch),checkedAt:new Date().toISOString()};
}

// Main owns the trusted release and file path. Renderer IPC accepts no URL or
// path. Node fetch shares no cookies or financial credentials with the API.
class UpdateClient {
  constructor({currentVersion,platform=process.platform,arch=process.arch,directory,fetchImpl=fetch,opener}){
    Object.assign(this,{currentVersion,platform,arch,directory,fetchImpl,opener});
    this.state='idle';this.busy=false;this.revision=0;this.downloaded=0;this.release=null;this.file=null;this.error='';
  }
  info(){return {currentVersion:this.currentVersion,platform:this.platform,arch:this.arch,state:this.state,busy:this.busy,revision:this.revision,downloaded:this.downloaded,total:this.release?.assetSize||0,canDownload:!!this.release?.downloadUrl&&this.release.status==='available',canInstall:!!this.file,latestVersion:this.release?.latestVersion,notes:this.release?.notes,publishedAt:this.release?.publishedAt,checkedAt:this.release?.checkedAt,message:this.release?.message,error:this.error,releaseUrl:this.release?.releaseUrl||RELEASES_URL};}
  change(state){this.state=state;this.revision++;}
  stop(){this.controller?.abort();}
  async task(state,work){
    if(this.busy)fail('更新操作正在进行，请稍候。');
    this.busy=true;this.error='';this.cancelled=false;this.controller=new AbortController();this.change(state);
    const timer=setTimeout(()=>this.controller?.abort(),state==='downloading'?15*60*1000:30000);
    try{await work(this.controller.signal);}
    catch(error){this.error=this.cancelled?'':error.code==='UPDATE_FAILED'?error.message:'更新未完成，请检查网络和磁盘空间后重试。';this.change(this.cancelled?'cancelled':'error');}
    finally{clearTimeout(timer);this.busy=false;this.controller=null;this.revision++;}
    return this.info();
  }
  cancel(){if(this.state==='downloading'){this.cancelled=true;this.controller?.abort();}return this.info();}
  async check(){return this.task('checking',async signal=>{
    this.release=null;this.file=null;this.downloaded=0;
    this.release=await checkForUpdates({currentVersion:this.currentVersion,platform:this.platform,arch:this.arch,fetchImpl:this.fetchImpl,signal});
    signal.throwIfAborted();this.change(this.release.status);
  });}
  async validFile(filename,signal){
    try{
      const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.release.assetSize)return false;
      const hash=createHash('sha256');for await(const bytes of createReadStream(filename,{signal}))hash.update(bytes);
      return hash.digest('hex')===this.release.sha256;
    }catch(error){if(signal.aborted)throw error;return false;}
  }
  async download(){
    if(!this.release?.downloadUrl||this.release.status!=='available')fail('请先检查是否有可用的新版本。');
    return this.task('downloading',async signal=>{
      this.file=null;this.downloaded=0;
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const destination=path.join(this.directory,this.release.assetName),temporary=destination+'.part';
      if(await this.validFile(destination,signal)){this.file=destination;this.downloaded=this.release.assetSize;this.change('ready');return;}
      await fs.rm(temporary,{force:true});let handle;
      try{
        let url=this.release.downloadUrl,response;
        for(let redirects=0;redirects<=4;redirects++){
          response=await this.fetchImpl(url,{method:'GET',credentials:'omit',redirect:'manual',signal});
          if(![301,302,303,307,308].includes(response.status))break;
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location||redirects===4)fail('安装包下载重定向异常，请重新检查更新。');
          const next=new URL(location,url);
          if(next.protocol!=='https:'||next.username||next.password||next.port||next.hash||!['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))fail('安装包不是 GitHub 发布文件，已停止下载。');
          url=next.href;
        }
        if(response.status!==200||!response.body)fail('安装包下载失败，请重试。');
        const length=response.headers.get('content-length');
        if(length!==null&&Number(length)!==this.release.assetSize){await response.body.cancel();fail('安装包大小与发布信息不一致。');}
        handle=await fs.open(temporary,'wx',0o600);
        const hash=createHash('sha256'),reader=response.body.getReader();
        try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;this.downloaded+=value.length;this.revision++;if(this.downloaded>this.release.assetSize)fail('安装包大小超过发布信息。');hash.update(value);await handle.writeFile(value);}}
        finally{await reader.cancel().catch(()=>{});}
        signal.throwIfAborted();this.change('verifying');
        if(this.downloaded!==this.release.assetSize||hash.digest('hex')!==this.release.sha256)fail('安装包校验失败，请重新下载。');
        await handle.close();handle=null;
        await fs.rm(destination,{force:true});await fs.rename(temporary,destination);
        this.file=destination;this.change('ready');
      }finally{await handle?.close();await fs.rm(temporary,{force:true});}
    });
  }
  async install(){
    if(!this.file||!['ready','opened','error'].includes(this.state))fail('请先下载并校验安装包。');
    return this.task('opening',async signal=>{
      if(!await this.validFile(this.file,signal)){this.file=null;fail('本地安装包已变化，请重新下载。');}
      signal.throwIfAborted();if(await this.opener(this.file))fail('无法打开安装程序，请检查系统权限后重试。');
      this.change('opened');
    });
  }
}
module.exports={REPOSITORY,RELEASES_URL,newer,releaseInfo,checkForUpdates,UpdateClient};
