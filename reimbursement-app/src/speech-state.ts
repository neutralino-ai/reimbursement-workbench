export type SpeechPhase = 'idle'|'starting'|'recording'|'stopping'|'review';
export type SpeechEvent = {id:string;text:string;phase:'recording'|'stopping'|'review';message?:string};
export type SpeechState = {id:string;phase:SpeechPhase;text:string;message:string};
export const emptySpeech:SpeechState = {id:'',phase:'idle',text:'',message:''};
export const speechIsActive = (s:SpeechState)=>['starting','recording','stopping'].includes(s.phase);

// Ignore late results from cancelled runs and out-of-order partials after stop/final.
export function receiveSpeech(s:SpeechState,event:SpeechEvent):SpeechState {
  if(!s.id||s.id!==event.id||s.phase==='review'||s.phase==='idle')return s;
  if(s.phase==='stopping'&&event.phase==='recording')return s;
  return {...s,text:event.text,phase:event.phase,message:event.message||s.message};
}
export function appendDictation(original:string,transcript:string) {
  const added=transcript.trim();
  return added?original+(original&&!original.endsWith('\n')?'\n':'')+added:original;
}
export function mobileFilename(value:string) {
  // Keep a useful extension and Unicode names, but never a path or hidden filename.
  const name=value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g,'').replace(/^\.+/,'')||'附件.pdf';
  const dot=name.lastIndexOf('.');
  const ext=dot>=0&&name.length-dot<=12?name.slice(dot):'';
  let base=ext?name.slice(0,-ext.length):name;
  while(new TextEncoder().encode(base+ext).length>220)base=Array.from(base).slice(0,-1).join('');
  return base+ext;
}
