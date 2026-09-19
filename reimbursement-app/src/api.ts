import {validateDesktopAPI} from './desktop';
import {connectionBridge} from './mobile';

export const appBase = import.meta.env.BASE_URL.replace(/\/$/, '');
let endpoint: URL | undefined;
let configuration: Promise<void> | undefined;
let memorySession: {token:string; expiresAt:string} | null = null;

export function configureAPI(value:string) {
  const next=new URL(value);
  const loopback=next.hostname==='localhost'||next.hostname==='127.0.0.1'||next.hostname==='[::1]';
  if ((next.protocol!=='https:'&&!(next.protocol==='http:'&&loopback))||next.username||next.password||next.search||next.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(next.pathname)) throw new Error('API 地址须为 HTTPS；本机测试可使用 loopback HTTP。');
  next.pathname=next.pathname.replace(/\/$/,'');
  if(endpoint&&endpoint.href!==next.href)memorySession=null;
  endpoint=next;
}

export async function loadFrontendConfig() {
  if(endpoint)return;
  if(!configuration)configuration=(async()=>{
    const desktop=connectionBridge();
    if(desktop){
      const config=await desktop.getConnection();
      configureAPI(validateDesktopAPI(config.apiBaseUrl));
      return;
    }
    if(window.location.protocol==='file:')throw new Error('请通过本地前端启动器打开网页。');
    const response=await fetch(`${appBase}/frontend-config.json`,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('无法读取前端连接配置 frontend-config.json。');
    const config=await response.json();
    if(typeof config?.apiBaseUrl!=='string')throw new Error('前端配置缺少 apiBaseUrl。');
    configureAPI(config.apiBaseUrl);
  })().catch(error=>{configuration=undefined;throw error;});
  await configuration;
}

export function isRemoteAPI() {return Boolean(endpoint&&endpoint.origin!==window.location.origin);}
export function apiAddress() {return endpoint?.href.replace(/\/$/,'')||'';}
function sessionKey() {return `reimbursement-session:${apiAddress()}`;}
export function clearSession() {memorySession=null;try{sessionStorage.removeItem(sessionKey());}catch{}}
export function saveSession(token:string,expiresAt:string) {
  if(!/^[a-f0-9]{64}$/.test(token)||!Number.isFinite(Date.parse(expiresAt)))throw new Error('服务器返回了无效的登录会话。');
  memorySession={token,expiresAt};
  try{sessionStorage.setItem(sessionKey(),JSON.stringify(memorySession));}catch{}
}
function currentSession() {
  let session=memorySession;
  if(!session)try{session=JSON.parse(sessionStorage.getItem(sessionKey())||'null');}catch{}
  if(!session||!/^[a-f0-9]{64}$/.test(session.token)||!(Date.parse(session.expiresAt)>Date.now())){clearSession();return null;}
  return session.token;
}

export function apiURL(value:string):string {
  if(!endpoint)throw new Error('API 连接尚未初始化。');
  const basePath=endpoint.pathname.replace(/\/$/,'');
  let path=value;
  if(/^https?:\/\//i.test(value)) {
    const supplied=new URL(value);
    if(supplied.origin!==endpoint.origin||supplied.username||supplied.password)throw new Error('附件地址不属于当前 API。');
    path=supplied.pathname+supplied.search;
  }
  if(basePath&&path.startsWith(basePath+'/api/'))path=path.slice(basePath.length);
  if(!path.startsWith('/api/'))throw new Error('请求须使用工作台 API 路径。');
  const url=new URL(endpoint.origin+basePath+path);
  if(!url.pathname.startsWith(basePath+'/api/')||url.hash)throw new Error('无效的 API 路径。');
  return url.href;
}

export async function apiFetch(path:string,options:RequestInit={}):Promise<Response> {
  await loadFrontendConfig();
  const headers=new Headers(options.headers);
  headers.delete('Authorization');
  const session=currentSession();
  if(session)headers.set('Authorization',`Session ${session}`);
  if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  let response:Response;
  try {
    response=await fetch(apiURL(path),{...options,headers,credentials:'omit',redirect:'error',signal:options.signal||AbortSignal.timeout(60000)});
  }catch(error){
    if(options.signal?.aborted)throw error;
    throw new Error('无法连接远程 API。请检查接口地址、网络及服务器跨域配置。');
  }
  if(response.status===401&&!path.includes('/api/auth/')) {
    clearSession();window.dispatchEvent(new Event('reimbursement-session-expired'));
  }
  if(!response.ok) {
    const body=await response.json().catch(()=>null);
    throw new Error(body?.error||`请求失败（${response.status}）`);
  }
  return response;
}

export async function api<T>(path:string,options?:RequestInit):Promise<T> {
  return (await apiFetch(path,options)).json() as Promise<T>;
}
