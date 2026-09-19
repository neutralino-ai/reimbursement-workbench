import {useEffect, useState, type FormEvent, type ReactNode} from 'react';
import {api, apiAddress, clearSession, saveSession} from './api';
import {desktopBridge,readSetupToken} from './desktop';
import {connectionBridge} from './mobile';
import ConnectionSettings from './ConnectionSettings';
import UpdateCheck from './UpdateCheck';
import './auth.css';
type AuthState = {enabled:boolean; configured:boolean; authenticated:boolean};
export default function AuthGate({children}:{children:ReactNode}) {
  const [state,setState] = useState<AuthState|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [connecting,setConnecting] = useState(true);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [setupInput,setSetupInput] = useState('');
  const [password,setPassword] = useState('');
  const [confirm,setConfirm] = useState('');
  const [setupToken,setSetupToken] = useState(() => {
    const token=new URLSearchParams(window.location.hash.slice(1)).get('setup')||'';
    return /^[a-f0-9]{64}$/.test(token)?token:'';
  });
  const [message,setMessage] = useState('');
  const desktop=Boolean(desktopBridge());
  const configurable=Boolean(connectionBridge());
  async function refresh() {
    setConnecting(true);
    try {const next=await api<AuthState>('/api/auth/status');if(!next.authenticated)clearSession();setState(next);}
    finally {setConnecting(false);}
  }
  useEffect(() => {
    void refresh().catch(err=>setError(err.message));
    const expired=()=>{setState(previous=>previous?{...previous,authenticated:false}:null);setError('会话已过期，请重新登录。');};
    window.addEventListener('reimbursement-session-expired',expired);
    return ()=>window.removeEventListener('reimbursement-session-expired',expired);
  },[]);
  function importSetup(event:FormEvent) {
    event.preventDefault();setError('');
    try {setSetupToken(readSetupToken(setupInput,apiAddress()));setSetupInput('');setPassword('');setConfirm('');}
    catch(err){setError(err instanceof Error?err.message:'设置链接无效。');}
  }
  async function submit(event:FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (!state?.configured) {
        if (password !== confirm) throw new Error('两次密码不一致。');
        await api('/api/auth/setup',{method:'POST',body:JSON.stringify({token:setupToken,password})});
        setSetupToken(''); window.history.replaceState(null,'',window.location.pathname);
        setMessage('密码已设置，请登录。'); setPassword(''); setConfirm('');
      } else {
        const session=await api<{sessionToken:string;expiresAt:string}>('/api/auth/login',{method:'POST',body:JSON.stringify({password,sessionMode:'header'})});
        saveSession(session.sessionToken,session.expiresAt);setPassword('');setMessage('');
      }
      await refresh();
    } catch(err) { setError(err instanceof Error?err.message:'操作失败'); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);setError('');
    try{await api('/api/auth/logout',{method:'POST',body:'{}'});}
    catch{setError('本机已退出；网络连接失败，服务器会话撤销尚未确认。');}
    finally{clearSession();setState(previous=>previous?{...previous,authenticated:false}:null);setBusy(false);}
  }
  const settings=settingsOpen?<ConnectionSettings onClose={()=>setSettingsOpen(false)}/>:null;
  if (state && (!state.enabled || state.authenticated)) return <>{(state.enabled||configurable)&&<div className="cloud-session"><span title={apiAddress()}>{configurable?apiAddress():'云端工作区'}</span>{configurable&&<button onClick={()=>setSettingsOpen(true)} disabled={busy}>服务器连接</button>}{desktop&&<UpdateCheck/>}{state.enabled&&<button onClick={()=>void logout()} disabled={busy}>退出登录</button>}{error&&<span role="alert">{error}</span>}</div>}{children}{settings}</>;
  return <main className="auth-page"><section className="auth-card"><div className="auth-mark">报</div><h1>报销工作台</h1><p>{!state?connecting?'正在连接服务器…':'未能连接服务器。':state.configured?'登录以查看和维护报销材料。':setupToken?'首次使用，请设置登录密码。':configurable?'首次使用，请粘贴一次性设置链接。':'工作台尚未设置密码。请使用管理员提供的一次性设置链接。'}</p>
    {configurable&&state&&!state.configured&&!setupToken&&<form onSubmit={importSetup}>
      <label className="field-label">一次性设置链接或设置码<input required type="password" autoComplete="off" spellCheck={false} value={setupInput} onChange={event=>setSetupInput(event.target.value)} disabled={busy}/></label>
      <button className="button secondary full-width" type="submit" disabled={busy}>继续设置密码</button>
    </form>}
    {state && (state.configured || setupToken) && <form onSubmit={submit}>
      <label className="field-label">{state.configured?'密码':'设置密码'}<input autoFocus required type="password" minLength={state.configured?undefined:12} maxLength={128} autoComplete={state.configured?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} /></label>
      {!state.configured && <><p className="small-muted">至少 12 个字符，可使用一句容易记住的长密码。</p><label className="field-label">再次输入密码<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy} /></label>{configurable&&<button className="setup-change" type="button" disabled={busy} onClick={()=>{setSetupToken('');setPassword('');setConfirm('');setError('');}}>更换设置链接</button>}</>}
      <button className="button primary full-width" type="submit" disabled={busy}>{busy?'处理中…':state.configured?'登录':'设置密码'}</button>
    </form>}{error && <p className="feedback error" role="alert">{error}</p>}{message && <p className="feedback success" role="status">{message}</p>}
    {!state&&error&&<button className="button secondary" disabled={connecting} onClick={()=>{setError('');void refresh().catch(err=>setError(err.message));}}>{connecting?'正在连接…':'重新连接'}</button>}
    <footer><span className="auth-api-address">API：{apiAddress()||(connecting?'正在读取连接配置':'尚未读取连接配置')}</span><span>财务材料保存在服务器</span>{configurable&&<button type="button" className="connection-link" disabled={busy} onClick={()=>setSettingsOpen(true)}>服务器连接</button>}{desktop&&<UpdateCheck/>}</footer>
  </section>{settings}</main>;
}
