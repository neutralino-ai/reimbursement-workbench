import {useEffect,useRef,useState,type FormEvent} from 'react';
import {apiAddress,clearSession} from './api';
import {validateDesktopAPI} from './desktop';
import {connectionBridge} from './mobile';

export default function ConnectionSettings({onClose}:{onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [address,setAddress]=useState(apiAddress());
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(!apiAddress());
  useEffect(()=>{
    dialog.current?.showModal();
    let active=true;
    if(!apiAddress())void connectionBridge()?.getConnection().then(config=>{if(active)setAddress(config.apiBaseUrl);}).catch(()=>{if(active)setError('无法读取已保存的地址，请重新填写。');}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  async function save(event:FormEvent) {
    event.preventDefault();setError('');setBusy(true);
    try {
      const bridge=connectionBridge();
      if(!bridge)throw new Error('请在桌面或 iOS 应用中修改服务器地址。');
      await bridge.saveConnection({apiBaseUrl:validateDesktopAPI(address)});
      clearSession();
      window.location.reload();
    }catch(err){setError(err instanceof Error?err.message:'保存失败，请重试。');setBusy(false);}
  }
  return <dialog ref={dialog} className="connection-dialog" aria-labelledby="connection-title" onCancel={event=>{if(busy)event.preventDefault();else onClose();}}>
    <form onSubmit={save}>
      <div className="connection-heading"><h2 id="connection-title">服务器连接</h2><button className="connection-close" type="button" aria-label="关闭服务器连接设置" disabled={busy} onClick={onClose}>×</button></div>
      <p>此应用连接远程报销 API，数据和原件保存在服务器。</p>
      <label className="field-label">API 地址<input autoFocus type="url" required spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="https://api.example.com/reimbursement" value={address} onChange={event=>setAddress(event.target.value)} disabled={busy||loading} /></label>
      <p className="connection-note">填写服务地址，不包含 /api。保存后应用会重新加载，并退出当前登录。</p>
      {error&&<p className="feedback error" role="alert">{error}</p>}
      <div className="connection-actions"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy||loading}>{busy?'正在保存…':'保存并重新连接'}</button></div>
    </form>
  </dialog>;
}
