export type DesktopConnection = {apiBaseUrl:string};
export type UpdateResult = {status:'available'|'current'|'unavailable';currentVersion:string;latestVersion?:string;releaseUrl:string;downloadUrl?:string|null;assetName?:string|null;publishedAt?:string|null;checkedAt?:string;notes?:string;message?:string};
export type DesktopBridge = {
  version:1;
  getConnection:()=>Promise<DesktopConnection>;
  saveConnection:(connection:DesktopConnection)=>Promise<DesktopConnection>;
  getVersion?:()=>Promise<string>;
  checkForUpdates?:()=>Promise<UpdateResult>;
  openUpdate?:()=>Promise<void>;
};

declare global {
  interface Window { reimbursementDesktop?:DesktopBridge; }
}

export function desktopBridge() {
  const bridge=window.reimbursementDesktop;
  return bridge?.version===1&&typeof bridge.getConnection==='function'&&typeof bridge.saveConnection==='function'?bridge:undefined;
}

export function validateDesktopAPI(value:string) {
  let url:URL;
  try {url=new URL(value.trim());} catch {throw new Error('请输入完整的 HTTPS API 地址。');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)) {
    throw new Error('API 地址须使用 HTTPS，不能包含账号、密码、查询参数或片段。');
  }
  return url.href.replace(/\/$/,'');
}

export function readSetupToken(value:string,currentAPI:string) {
  const source=value.trim();
  if(/^[a-f0-9]{64}$/.test(source))return source;
  let url:URL;
  try {url=new URL(source);} catch {throw new Error('请输入完整的一次性设置链接或 64 位设置码。');}
  const api=new URL(currentAPI);
  const fromAPI=url.protocol==='https:'&&url.origin===api.origin&&url.pathname.replace(/\/$/,'')===api.pathname.replace(/\/$/,'');
  const fromLocalFrontend=url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='4317'&&url.pathname==='/';
  if(url.username||url.password||url.search||(!fromAPI&&!fromLocalFrontend))throw new Error('设置链接不属于当前服务器或本地报销工作台。');
  const fragment=new URLSearchParams(url.hash.slice(1));
  const token=fragment.get('setup')||'';
  if(fragment.size!==1||!/^[a-f0-9]{64}$/.test(token))throw new Error('设置链接中的设置码无效。');
  return token;
}
