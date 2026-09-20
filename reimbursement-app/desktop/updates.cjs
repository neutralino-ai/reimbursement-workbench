'use strict';
const REPOSITORY='neutralino-ai/reimbursement-workbench';
const RELEASES_URL=`https://github.com/${REPOSITORY}/releases`;
function versionParts(value){const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value||'');return m?m.slice(1).map(BigInt):null;}
function newer(candidate,current){const a=versionParts(candidate),b=versionParts(current);if(!a||!b)throw new Error('版本号无效');for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
function releaseInfo(release,currentVersion,platform,arch){
  if(!versionParts(currentVersion))throw new Error('当前版本无效');
  if(!release||release.draft||release.prerelease||!versionParts(release.tag_name))throw new Error('Release 不是有效的正式版本');
  const version=release.tag_name.replace(/^v/,'');
  const releaseUrl=`${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
  if(release.html_url!==releaseUrl)throw new Error('Release 地址不属于本项目');
  const os=platform==='win32'?'win':platform==='darwin'?'mac':null;
  const filename=os&&['x64','arm64'].includes(arch)?`Reimbursement-${version}-${os}-${arch}.${os==='win'?'exe':'zip'}`:null;
  const expected=filename?`https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`:null;
  const asset=(release.assets||[]).find(a=>a.name===filename&&a.state==='uploaded'&&a.size>0&&a.browser_download_url===expected);
  const status=newer(version,currentVersion)?'available':newer(currentVersion,version)?'ahead':'current';
  return {status,currentVersion,latestVersion:version,releaseUrl,downloadUrl:asset?expected:null,assetName:asset?filename:null,publishedAt:release.published_at||null,notes:typeof release.body==='string'?release.body.slice(0,6000):''};
}
async function checkForUpdates({currentVersion,platform=process.platform,arch=process.arch,fetchImpl=fetch}){
  let response;
  try {response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':`Reimbursement/${currentVersion}`},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch {throw new Error('无法连接 GitHub，请检查网络后重试');}
  if(response.status===404)return {status:'unavailable',currentVersion,releaseUrl:RELEASES_URL,message:'尚无公开的正式 Release，或仓库暂不可访问'};
  if(response.status===429||(response.status===403&&response.headers.get('x-ratelimit-remaining')==='0'))throw new Error('GitHub 请求限额已用完，请稍后再试');
  if(!response.ok)throw new Error(`GitHub 返回 HTTP ${response.status}，请稍后重试`);
  const text=await response.text();if(text.length>1024*1024)throw new Error('Release 信息过大');
  return {...releaseInfo(JSON.parse(text),currentVersion,platform,arch),checkedAt:new Date().toISOString()};
}
module.exports={REPOSITORY,RELEASES_URL,newer,releaseInfo,checkForUpdates};
