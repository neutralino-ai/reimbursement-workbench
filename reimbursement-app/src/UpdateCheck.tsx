import {useEffect,useRef,useState} from 'react';
import {desktopBridge,type UpdateResult} from './desktop';

export default function UpdateCheck(){
  const bridge=desktopBridge();
  const dialog=useRef<HTMLDialogElement>(null);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const [version,setVersion]=useState(''),[error,setError]=useState('');
  const [result,setResult]=useState<UpdateResult|null>(null);
  useEffect(()=>{void bridge?.getVersion?.().then(setVersion).catch(()=>{});},[bridge]);
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  if(!bridge?.checkForUpdates)return null;
  async function check(){
    setOpen(true);setBusy(true);setError('');setResult(null);
    try{setResult(await bridge!.checkForUpdates!());}catch(err){setError(err instanceof Error?err.message:'检查更新失败');}finally{setBusy(false);}
  }
  async function download(){try{await bridge!.openUpdate!();}catch{setError('无法打开下载页面，请重试');}}
  return <><button type="button" className="update-trigger" onClick={()=>void check()}>检查更新{version&&<span> v{version}</span>}</button>{open&&<dialog ref={dialog} className="connection-dialog update-dialog" aria-labelledby="update-title" onCancel={()=>setOpen(false)}>
    <div className="connection-heading"><h2 id="update-title">检查更新</h2><button type="button" className="connection-close" aria-label="关闭检查更新" onClick={()=>setOpen(false)}>×</button></div>
    <p>当前版本：{version?`v${version}`:'读取中'}</p>
    <div aria-live="polite">{busy&&<p>正在查询 GitHub Release…</p>}{error&&<p className="feedback error" role="alert">{error}</p>}
      {result?.status==='current'&&<p>当前已是最新版本。最新正式版：v{result.latestVersion}</p>}
      {result?.status==='ahead'&&<p>本机版本 v{result.currentVersion} 高于公开正式版 v{result.latestVersion}。这通常是尚未发布的本地构建，不会自动降级或覆盖。</p>}
      {result?.status==='unavailable'&&<p>{result.message}</p>}
      {result?.status==='available'&&<><p className="update-found">发现新版本 v{result.latestVersion}</p>{result.publishedAt&&<p>发布时间：{new Date(result.publishedAt).toLocaleDateString()}</p>}{result.notes&&<pre className="update-notes">{result.notes}</pre>}<p>{result.downloadUrl?'点击下载后，在浏览器保存安装包，再退出当前客户端并打开新版。':'这个版本尚无当前系统的安装包，可前往 Release 查看。'}</p></>}
    </div>
    <div className="connection-actions"><button type="button" className="button secondary" onClick={()=>void check()} disabled={busy}>重新检查</button>{result?.status==='available'&&<button type="button" className="button primary" onClick={()=>void download()}>{result.downloadUrl?'下载新版本':'查看 Release'}</button>}</div>
  </dialog>}</>;
}
