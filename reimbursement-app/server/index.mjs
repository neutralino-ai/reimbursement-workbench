import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createStore} from './store.mjs';
import {executeAgentCommand,getAgentCatalog} from './agent.mjs';
import {createCloudAuth} from './cloud-auth.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
const MAX_BODY = 30 * 1024 * 1024;

function frontendOrigins(values) {
  return new Set(values.map(value=>{
    // Electron registers this exact standard, secure origin. It is opt-in and
    // must not expand the allowlist to opaque or arbitrary custom schemes.
    if(value==='reimbursement://app')return value;
    const parsed=new URL(value);
    const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
    if((parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&local))||parsed.origin!==value||parsed.username||parsed.password)throw new Error('前端来源必须为完整 HTTPS Origin、本机 HTTP Origin 或 reimbursement://app，不允许通配符。');
    return parsed.origin;
  }));
}

function writeJSON(res, status, payload, basePath = '') {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload,(key,value)=>basePath && key==='href' && typeof value==='string' && value.startsWith('/api/') ? basePath+value : value));
}

async function body(req, maximum = MAX_BODY) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw Object.assign(new Error('请求须使用 JSON 格式'), {statusCode:415});
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('请求内容超过大小限制'), {statusCode:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求内容不是有效 JSON'), {statusCode:400}); }
}

export async function createApp(options = {}) {
  const publicValue = options.publicUrl || process.env.REIMBURSE_PUBLIC_URL;
  const publicURL = publicValue ? new URL(publicValue) : null;
  if (publicURL && (publicURL.protocol !== 'https:' || publicURL.username || publicURL.password || publicURL.search || publicURL.hash || !/^\/[a-zA-Z0-9/_-]*$/.test(publicURL.pathname))) throw new Error('云端公共地址必须为无凭据的 HTTPS 地址。');
  if (publicURL && options.dev) throw new Error('云端服务只允许生产构建。');
  const basePath = publicURL?.pathname.replace(/\/$/,'') || '';
  const configuredOrigins=frontendOrigins(options.frontendOrigins || (process.env.REIMBURSE_FRONTEND_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean));
  const apiOnly=options.apiOnly ?? (Boolean(publicURL)||process.env.REIMBURSE_API_ONLY==='1');
  if(apiOnly&&options.dev)throw new Error('独立后端不加载前端开发服务器。');
  const json = (res,status,payload)=>writeJSON(res,status,payload,basePath);
  const dataDir = path.resolve(options.dataDir || process.env.REIMBURSE_DATA_DIR || path.join(appDir,'data'));
  const auth = publicURL ? createCloudAuth({dataDir,publicOrigin:publicURL.origin,basePath:basePath || '/',trustLoopbackProxy:process.env.REIMBURSE_TRUST_LOOPBACK_PROXY==='1'}) : null;
  const legacyValue=options.legacyDir || process.env.REIMBURSE_LEGACY_DIR || (!(options.dataDir||process.env.REIMBURSE_DATA_DIR) ? path.resolve(appDir,'../LLM-报销') : undefined);
  const legacyCandidate=legacyValue ? path.resolve(legacyValue) : undefined;
  const legacyDir = legacyCandidate&&fs.existsSync(path.join(legacyCandidate,'private-data','AppData','workspace.json')) ? legacyCandidate : undefined;
  const store = createStore({
    dataDir,
    legacyDir,
  });
  const agentConfigPath = path.join(dataDir,'agent-access.json');
  if (!fs.existsSync(agentConfigPath)) fs.writeFileSync(agentConfigPath,JSON.stringify({version:1,token:randomBytes(32).toString('hex')},null,2),{flag:'wx',mode:0o600});
  const agentToken = JSON.parse(fs.readFileSync(agentConfigPath,'utf8')).token;
  if (typeof agentToken !== 'string' || !/^[a-f0-9]{64}$/.test(agentToken)) throw new Error('本地 Agent 密钥配置无效');
  const agentAuthorized = req => {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if(!supplied)return false;
    return Buffer.byteLength(supplied) === Buffer.byteLength(agentToken) && timingSafeEqual(Buffer.from(supplied),Buffer.from(agentToken));
  };
  let vite;
  if (options.dev) {
    const {createServer} = await import('vite');
    const privatePaths = [dataDir,legacyDir].filter(Boolean).map(directory=>directory.replaceAll('\\','/')+'/**');
    vite = await createServer({root:appDir,server:{middlewareMode:true,host:'127.0.0.1',fs:{strict:true,deny:['**/.env','**/.env.*','**/.npmrc','**/.yarnrc*','**/*.{crt,pem,key,p12,pfx}','**/.git/**','**/data/**','**/materials/**','**/imports/**','**/.pnpm-store/**',...privatePaths]}},appType:'spa'});
  }
  const dist = path.join(appDir,'dist');
  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 4317;
    const hosts = new Set(publicURL ? [publicURL.host] : [`127.0.0.1:${port}`,`localhost:${port}`]);
    if (!hosts.has(req.headers.host)) return json(res,403,{error:'请求地址不受支持'});
    const origin = req.headers.origin;
    const origins = new Set(publicURL ? [publicURL.origin,...configuredOrigins] : [...hosts].map(host => `http://${host}`));
    if ((origin && !origins.has(origin)) || (req.headers['sec-fetch-site'] === 'cross-site'&&(!origin||!origins.has(origin)))) {
      return json(res,403,{error:'拒绝跨站请求'});
    }
    let url;
    try { url = new URL(req.url, publicURL?.origin || `http://${req.headers.host}`); }
    catch { return json(res,400,{error:'无效请求地址'}); }
    if (basePath && url.pathname === basePath) { res.writeHead(308,{Location:basePath+'/'}); return res.end(); }
    if (basePath && !url.pathname.startsWith(basePath+'/')) return json(res,404,{error:'没有找到此接口'});
    const route = basePath ? url.pathname.slice(basePath.length) : url.pathname;
    if(origin&&origins.has(origin)&&route.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition,Retry-After');
    }
    if(req.method==='OPTIONS'&&route.startsWith('/api/')) {
      const method=req.headers['access-control-request-method'];
      const requestedHeaders=(req.headers['access-control-request-headers']||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
      if(!origin||!origins.has(origin)||!['GET','POST','DELETE','HEAD'].includes(method)||requestedHeaders.some(value=>!['authorization','content-type'].includes(value)))return json(res,403,{error:'跨域请求不受支持'});
      res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,DELETE,HEAD','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'600','Cache-Control':'no-store'});
      return res.end();
    }
    const isAgentRoute = route.startsWith('/api/agent/');
    const isMaterialRead = /^\/api\/materials\/[^/]+$/.test(route) && req.method==='GET';
    const authenticatedAgent = (isAgentRoute || isMaterialRead) && agentAuthorized(req);
    const isHumanSessionHeader = Boolean(auth)&&/^Session [a-f0-9]{64}$/.test(req.headers.authorization||'');
    if (isAgentRoute && !authenticatedAgent) return json(res,401,{error:'Agent API 需要有效的访问令牌'});
    if (!isAgentRoute && !isMaterialRead && req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent 令牌不能作为人工操作身份。'});
    if (!['GET','HEAD'].includes(req.method) && (!origin || !origins.has(origin)) && !authenticatedAgent) {
      return json(res,403,{error:'修改操作须来自工作台页面'});
    }
    try {
      if (route === '/api/auth/status' && req.method==='GET') return json(res,200,auth ? auth.status(req) : {enabled:false,configured:true,authenticated:true});
      if (route.startsWith('/api/auth/')) {
        if (!auth) return json(res,404,{error:'本地模式未启用登录'});
        if (req.method!=='POST') return json(res,405,{error:'此操作不受支持'});
        const input = await body(req,4096);
        if (route==='/api/auth/setup') return json(res,200,await auth.setup(input));
        if (route==='/api/auth/login') {
          const session = await auth.login(input.password,req);
          if(input.sessionMode==='header')return json(res,200,{authenticated:true,sessionToken:session.sessionToken,expiresAt:session.expiresAt});
          res.setHeader('Set-Cookie',session.cookie);
          return json(res,200,{authenticated:true,expiresAt:session.expiresAt});
        }
        if (route==='/api/auth/logout') {res.setHeader('Set-Cookie',await auth.logout(req));return json(res,200,{authenticated:false});}
        return json(res,404,{error:'没有找到此接口'});
      }
      if (auth && route.startsWith('/api/') && !authenticatedAgent && !auth.status(req).authenticated) return json(res,401,{error:'请先登录'});
      if (route === '/api/agent/catalog' && req.method === 'GET') return json(res,200,{tools:getAgentCatalog()});
      if (route === '/api/agent/workspace' && req.method === 'GET') return json(res,200,store.workspace());
      if (route === '/api/agent/tasks' && req.method === 'GET') return json(res,200,store.agentTasks());
      if (route === '/api/agent/history' && req.method === 'GET') return json(res,200,store.history({limit:1000}));
      if (route === '/api/agent/commands' && req.method === 'POST') return json(res,200,executeAgentCommand(store,await body(req)));
      if (route === '/api/workspace' && req.method === 'GET') return json(res,200,store.workspace());
      if (route === '/api/tasks' && req.method === 'GET') return json(res,200,store.agentTasks());
      if (route === '/api/policies/upload' && req.method === 'POST') {
        if (req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent 请使用 material.import 和 policy.register 并保留 Agent 身份'});
        return json(res,200,store.uploadPolicy(await body(req)));
      }
      const policyMatch = route.match(/^\/api\/policies\/([^/]+)$/);
      if (policyMatch && req.method === 'POST') {
        if (req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent 请使用 policy.register 并保留 Agent 身份'});
        return json(res,200,store.updatePolicy(decodeURIComponent(policyMatch[1]),await body(req)));
      }
      const deliveryMatch = route.match(/^\/api\/records\/([^/]+)\/delivery$/);
      if (deliveryMatch && req.method === 'POST') {
        if (req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent 请使用 delivery.set 并保留 Agent 身份'});
        return json(res,200,store.setDelivery(decodeURIComponent(deliveryMatch[1]),await body(req)));
      }
      const uploadMatch = route.match(/^\/api\/records\/([^/]+)\/materials$/);
      if (uploadMatch && req.method === 'POST') {
        if (req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent 请使用 material.import 并保留 Agent 身份'});
        return json(res,200,store.importRecordMaterial(decodeURIComponent(uploadMatch[1]),await body(req)));
      }
      let verificationMatch = route.match(/^\/api\/records\/([^/]+)\/verify$/);
      if (verificationMatch && req.method === 'POST') {
        if (req.headers.authorization&&!isHumanSessionHeader) return json(res,403,{error:'Agent token 不可代替人工核验'});
        return json(res,200,store.verifyRecord(decodeURIComponent(verificationMatch[1]),await body(req)));
      }
      if (route === '/api/export' && req.method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="reimbursement-review.json"');
        return json(res,200,{exportedAt:new Date().toISOString(),notice:'仅包含核对数据，来源覆盖未确认完整；原始附件请保留 data 目录备份。',...store.workspace()});
      }
      let match = route.match(/^\/api\/records\/([^/]+)\/review$/);
      if (match && req.method === 'POST') return json(res,200,store.reviewRecord(decodeURIComponent(match[1]),await body(req)));
      if (route === '/api/allocations' && req.method === 'POST') return json(res,201,store.allocate(await body(req)));
      match = route.match(/^\/api\/allocations\/([^/]+)$/);
      if (match && req.method === 'DELETE') return json(res,200,store.removeAllocation(decodeURIComponent(match[1])));
      if (route === '/api/import/apple-card' && req.method === 'POST') return json(res,200,store.importAppleCard(await body(req)));
      match = route.match(/^\/api\/materials\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const material = store.material(decodeURIComponent(match[1]));
        const inline = url.searchParams.get('download') !== '1' && /^(application\/pdf|image\/)/.test(material.mime);
        res.writeHead(200, {'Content-Type':material.mime,'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(material.filename)}`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});
        const stream = fs.createReadStream(material.path);
        stream.on('error',()=>res.destroy());
        return stream.pipe(res);
      }
      if (route.startsWith('/api/')) return json(res,404,{error:'没有找到此接口'});
      if(apiOnly)return json(res,404,{error:'此服务只提供 API；请从独立前端打开工作台。'});
      if (!['GET','HEAD'].includes(req.method)) return json(res,405,{error:'此操作不受支持'});
      if (vite) return vite.middlewares(req,res,()=>json(res,404,{error:'没有找到页面'}));
      const requested = path.resolve(dist,'.'+decodeURIComponent(route));
      if (requested !== dist && !requested.startsWith(dist+path.sep)) return json(res,403,{error:'路径不允许'});
      const file = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(dist,'index.html');
      if (!fs.existsSync(file)) return json(res,503,{error:'前端尚未构建，请先运行 pnpm build'});
      res.setHeader('Content-Type',mimeTypes[path.extname(file)]||'application/octet-stream');
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After',String(error.retryAfter));
      if (!res.headersSent) json(res,error.statusCode||400,{error:error.message||'操作未完成'});
      else res.destroy();
    }
  });
  async function close() {
    await new Promise(resolve=>server.close(resolve));
    if (vite) await vite.close();
    store.close();
    auth?.close();
  }
  return {server,store,close,agentConfigPath};
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  if (!process.env.REIMBURSE_PUBLIC_URL && fs.existsSync(path.join(appDir,'client-connection.json')) && !process.argv.includes('--local')) {
    throw new Error('此设备已连接云端。请打开云端工作台；只有明确检查本地备份时才使用 --local。');
  }
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须在 1024-65535 之间');
  const application = await createApp({dev:!process.env.REIMBURSE_PUBLIC_URL && !fs.existsSync(path.join(appDir,'dist/index.html'))});
  application.server.listen(port,'127.0.0.1',()=>console.log(`订阅报销工作台：${process.env.REIMBURSE_PUBLIC_URL || `http://127.0.0.1:${port}`}\n监听 127.0.0.1:${port}；${process.env.REIMBURSE_PUBLIC_URL?'云端鉴权已启用':'本地模式'}。`));
  application.server.on('error',async error=>{console.error(error.message);await application.close();process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await application.close();process.exit(0);});
}
