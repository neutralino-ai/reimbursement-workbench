import {Capacitor,registerPlugin,type PluginListenerHandle} from '@capacitor/core';
import {desktopBridge,validateDesktopAPI,type DesktopConnection} from './desktop';
import {mobileFilename,type SpeechEvent} from './speech-state';

export const isIOS = ()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='ios';
type ConnectionBridge = {getConnection:()=>Promise<DesktopConnection>;saveConnection:(config:DesktopConnection)=>Promise<DesktopConnection>};
const settings=registerPlugin<ConnectionBridge>('MobileSettings');
export function connectionBridge():ConnectionBridge|undefined {
  if(desktopBridge())return desktopBridge();
  if(!isIOS())return undefined;
  return {
    async getConnection(){
      const saved=await settings.getConnection();
      if(saved.apiBaseUrl)return {apiBaseUrl:validateDesktopAPI(saved.apiBaseUrl)};
      const response=await fetch('/frontend-config.json',{credentials:'omit'});
      if(!response.ok)throw new Error('无法读取应用连接配置。');
      const config=await response.json();
      return {apiBaseUrl:validateDesktopAPI(config.apiBaseUrl)};
    },
    saveConnection:config=>settings.saveConnection({apiBaseUrl:validateDesktopAPI(config.apiBaseUrl)}),
  };
}
export interface SpeechBridge {
  start:(options:{id:string;locale:string})=>Promise<void>;
  stop:(options:{id:string})=>Promise<void>;
  cancel:(options:{id:string})=>Promise<void>;
  addListener:(event:'transcript',listener:(event:SpeechEvent)=>void)=>Promise<PluginListenerHandle>;
}
export const speechInput=registerPlugin<SpeechBridge>('SpeechInput');
const files=registerPlugin<{present:(options:{filename:string;base64:string;mode:'preview'|'share'})=>Promise<void>}>('ReimbursementFiles');
export async function presentMobileFile(blob:Blob,filename:string,download:boolean) {
  if(blob.size>20*1024*1024)throw new Error('手机暂支持 20 MB 以内的附件，请用桌面客户端打开此文件。');
  const base64=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(new Error('文件读取失败。'));
    reader.readAsDataURL(blob);
  });
  await files.present({base64,filename:mobileFilename(filename),mode:download?'share':'preview'});
}
