import {useEffect,useRef,useState} from 'react';
import {desktopBridge,type UpdateInfo} from './desktop';

const megabytes=(bytes:number)=>(bytes/1024/1024).toFixed(1)+' MB';
export default function UpdateCheck(){
  const bridge=desktopBridge(),dialog=useRef<HTMLDialogElement>(null),mounted=useRef(true),actionBusy=useRef(false);
  const [open,setOpen]=useState(false),[info,setInfo]=useState<UpdateInfo|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
  function accept(next:UpdateInfo){if(mounted.current)setInfo(previous=>!previous||next.revision>=previous.revision?next:previous);}
  useEffect(()=>{
    mounted.current=true;let alive=true,inFlight=false;
    const refresh=async()=>{if(inFlight||!bridge?.getUpdateInfo)return;inFlight=true;try{const next=await bridge.getUpdateInfo();if(alive)accept(next);}catch{/* Explicit actions report errors; polling should not obscure a download. */}finally{inFlight=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),600);
    return()=>{alive=false;mounted.current=false;clearInterval(timer);};
  },[bridge]);
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  if(!bridge?.getUpdateInfo)return null;
  async function run(action:'checkForUpdates'|'downloadUpdate'|'installUpdate'){
    if(actionBusy.current||!bridge?.[action])return;
    actionBusy.current=true;setPending(true);setError('');
    try{accept(await bridge[action]!());}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'更新操作失败，请重试');}
    finally{actionBusy.current=false;if(mounted.current)setPending(false);}
  }
  async function show(){
    setOpen(true);
    try{const current=await bridge!.getUpdateInfo!();accept(current);if(['idle','current','ahead','unavailable'].includes(current.state)&&!current.busy)void run('checkForUpdates');}
    catch{setError('无法读取更新状态，请重试。');}
  }
  async function cancel(){try{accept(await bridge!.cancelUpdate!());}catch{setError('取消失败，请重试。');}}
  const state=info?.state||'idle',busy=pending||info?.busy===true,percent=info?.total?Math.min(100,Math.floor(info.downloaded/info.total*100)):0;
  const platform=info?.platform==='darwin'?`Mac · ${info.arch==='arm64'?'Apple Silicon':'Intel'}`:info?.platform==='win32'?'Windows · 64 位':'桌面客户端';
  const messages:Record<UpdateInfo['state'],string>={idle:'检查新版本',checking:'正在检查更新',available:`发现新版本 v${info?.latestVersion}`,current:'已是最新版本',ahead:'当前版本高于最新正式版',unavailable:'暂未找到正式版本',downloading:`正在下载 · ${percent}%`,verifying:'正在校验安装包',ready:'下载完成，可以安装',opening:'正在打开安装程序',opened:'安装程序已打开',cancelled:'下载已取消',error:'更新未完成'};
  return <><button type="button" className="update-trigger" onClick={()=>void show()}>{state==='downloading'?`更新下载中 ${percent}%`:state==='ready'?'更新已就绪':'检查更新'}{info&&<span> v{info.currentVersion}</span>}</button>{open&&<dialog ref={dialog} className="connection-dialog update-dialog" aria-labelledby="update-title" onCancel={()=>setOpen(false)}>
    <div className="connection-heading"><h2 id="update-title">应用更新</h2><button type="button" className="connection-close" aria-label="关闭检查更新" onClick={()=>setOpen(false)}>×</button></div>
    <div className="update-version-row"><span>当前版本 <strong>{info?'v'+info.currentVersion:'读取中'}</strong></span><span className="update-platform">{platform}</span></div>
    <section className={'update-status-card '+(['ready','current'].includes(state)?'is-success':state==='error'?'is-error':'')}>
      <div className="update-status-heading" role="status"><span className={'update-symbol '+(busy?'is-working':'')} aria-hidden="true">{busy?'':state==='ready'||state==='current'?'✓':state==='error'?'!':'↓'}</span><strong>{messages[state]}</strong></div>
      {['downloading','verifying'].includes(state)&&<><progress max={info?.total||1} value={info?.downloaded||0} aria-label="更新下载进度"/><div className="update-progress-meta"><span>{megabytes(info?.downloaded||0)} / {megabytes(info?.total||0)}</span><span>关闭窗口后继续下载</span></div></>}
      {state==='available'&&<p>{info?.message||(info?.total?`安装包 ${megabytes(info.total)}`:'可下载当前系统的安装包。')}</p>}
      {state==='ready'&&<p>安装包校验通过。{info?.platform==='darwin'?'打开后，将应用拖入 Applications 文件夹替换旧版。':'打开安装程序，按提示更新到新版本。'}</p>}
      {state==='opened'&&<p>{info?.platform==='darwin'?'在打开的窗口中将应用拖入 Applications，替换后重新启动。':'请按安装程序提示完成更新，再启动客户端。'}</p>}
      {state==='ahead'&&<p>最新正式版 v{info?.latestVersion}，保持当前版本。</p>}
      {state==='unavailable'&&<p>{info?.message}</p>}
      {(error||info?.error)&&<p className="feedback error" role="alert">{error||info?.error}</p>}
    </section>
    {info?.notes&&<details className="update-changelog"><summary>v{info.latestVersion} 更新内容{info.publishedAt&&<time>{new Date(info.publishedAt).toLocaleDateString()}</time>}</summary><div className="update-notes">{info.notes.split('\n').filter(line=>line.trim()).map((line,i)=><p key={i}>{line.replace(/^#{1,6}\s+|^[-*]\s+/,'').replace(/`([^`]+)`/g,'$1')}</p>)}</div></details>}
    <div className="update-actions"><button type="button" className="button secondary" onClick={()=>void run('checkForUpdates')} disabled={busy}>重新检查</button>
      {state==='downloading'&&<button type="button" className="button secondary" onClick={()=>void cancel()}>取消下载</button>}
      {!busy&&info?.canDownload&&!info.canInstall&&<button type="button" className="button primary" onClick={()=>void run('downloadUpdate')}>{['error','cancelled'].includes(state)?'重新下载':'下载更新'}</button>}
      {!busy&&info?.canInstall&&<button type="button" className="button primary" onClick={()=>void run('installUpdate')}>{state==='opened'?'再次打开安装程序':'打开安装程序'}</button>}
      {!busy&&state==='available'&&!info?.canDownload&&<button type="button" className="button primary" onClick={()=>void bridge.openUpdate?.().catch(()=>setError('无法打开发布页面。'))}>查看发布页面</button>}
    </div>
  </dialog>}</>;
}
