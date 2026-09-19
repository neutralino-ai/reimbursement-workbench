import {useEffect,useRef,useState} from 'react';
import {isIOS,speechInput,type SpeechBridge} from './mobile';
import {emptySpeech,receiveSpeech,speechIsActive,type SpeechState} from './speech-state';
import type {PluginListenerHandle} from '@capacitor/core';

type Props={disabled:boolean;onAdopt:(text:string)=>void;onActivity:(active:boolean)=>void;onPending:(pending:boolean)=>void};
export default function SpeechInput(props:Props){
  if(!isIOS())return <p className="small-muted">系统听写：Windows 按 Win + H；Mac 使用听写快捷键；手机可使用键盘麦克风。</p>;
  return <NativeSpeechInput {...props}/>;
}
// Separate component/adapter lets browser tests exercise the real UI without a microphone.
export function NativeSpeechInput({disabled,onAdopt,onActivity,onPending,bridge=speechInput}:Props&{bridge?:SpeechBridge}){
  const [state,setState]=useState<SpeechState>(emptySpeech),[locale,setLocale]=useState('zh-CN');
  const current=useRef(state),alive=useRef(false),listener=useRef<PluginListenerHandle|null>(null);
  const callbacks=useRef({onActivity,onPending});callbacks.current={onActivity,onPending};
  const active=speechIsActive(state);
  function update(next:SpeechState){current.current=next;if(alive.current)setState(next);}
  useEffect(()=>{alive.current=true;return()=>{
    alive.current=false;
    const id=current.current.id;current.current=emptySpeech;
    if(id)void bridge.cancel({id}).catch(()=>{});
    void listener.current?.remove();listener.current=null;
  };},[bridge]);
  useEffect(()=>{callbacks.current.onActivity(active);callbacks.current.onPending(Boolean(state.text.trim())||active);},[active,state.text]);
  async function start(){
    if(disabled||speechIsActive(current.current)||current.current.text.trim())return;
    const id=crypto.randomUUID();
    update({id,phase:'starting',text:'',message:''});
    try{
      await listener.current?.remove();listener.current=null;
      const handle=await bridge.addListener('transcript',event=>{
        if(alive.current)update(receiveSpeech(current.current,event));
      });
      if(!alive.current||current.current.id!==id){await handle.remove();return;}
      listener.current=handle;
      await bridge.start({id,locale});
      if(!alive.current||current.current.id!==id){await bridge.cancel({id});return;}
      if(current.current.phase==='starting')update({...current.current,phase:'recording'});
    }catch(error){
      if(alive.current&&current.current.id===id){
        await bridge.cancel({id}).catch(()=>{});
        update({...current.current,phase:'review',message:error instanceof Error?error.message:'无法开始录音，请检查系统权限。'});
      }
    }
  }
  async function stop(){
    const id=current.current.id;
    if(!id||!speechIsActive(current.current))return;
    update({...current.current,phase:'stopping'});
    try{await bridge.stop({id});}catch{
      await bridge.cancel({id}).catch(()=>{});
      if(alive.current&&current.current.id===id)update({...current.current,phase:'review',message:'录音连接中断，请检查已识别文字。'});
    }
  }
  async function discard(){
    const id=current.current.id;
    if(speechIsActive(current.current))return;
    update(emptySpeech);
    if(id)await bridge.cancel({id}).catch(()=>{});
  }
  function adopt(){
    if(active||!state.text.trim())return;
    onAdopt(state.text);
    update(emptySpeech);
  }
  return <section className="speech-input" aria-label="语音输入">
    <div className="speech-controls"><label>识别语言<select aria-label="识别语言" disabled={active||disabled||Boolean(state.text.trim())} value={locale} onChange={e=>setLocale(e.target.value)}><option value="zh-CN">普通话</option><option value="en-US">English</option></select></label>
      {active?<button type="button" className="button speech-stop" disabled={state.phase==='stopping'||state.phase==='starting'} onClick={()=>void stop()}>{state.phase==='starting'?'等待权限…':state.phase==='stopping'?'正在结束…':'停止录音'}</button>:<button type="button" className="button secondary" disabled={disabled||Boolean(state.text.trim())} onClick={()=>void start()}>语音输入</button>}
    </div>
    <p className="small-muted">在 iPhone 上转成文字，每段最长 55 秒。先查看、修改，再采用；原始录音不上传。</p>
    {state.phase!=='idle'&&<><label>本段识别文字<textarea aria-label="本段识别文字" rows={4} value={state.text} disabled={active} placeholder={active?'请说出用途和具体工作…':'未识别到文字，可重试或手动填写。'} onChange={e=>update({...current.current,text:e.target.value})}/></label>
      <p role="status">{state.message||(active?'正在听写…':'请检查识别结果。')}</p>
      <div className="ai-actions"><button type="button" className="button secondary" disabled={active||!state.text.trim()} onClick={adopt}>采用文字</button><button type="button" className="text-button" disabled={active} onClick={()=>void discard()}>丢弃本段</button></div>
    </>}
  </section>;
}
