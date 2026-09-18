import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./render_packet.py',import.meta.url));
export async function documentTool(command,input,workDir,{python=process.env.REIMBURSE_PYTHON||'python3'}={}){
  mkdirSync(workDir,{recursive:true,mode:0o700});
  const request=path.join(workDir,`${command}-request.json`),result=path.join(workDir,`${command}-result.json`);
  writeFileSync(request,JSON.stringify(input),{mode:0o600});
  await new Promise((resolve,reject)=>{
    const child=spawn(python,[script,command,request,result],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let error='';child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-2000);});child.stdout.resume();
    const timer=setTimeout(()=>{child.kill();reject(new Error('文档处理超时，未生成可提交文件。'));},120000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('文档运行时不可用，请检查服务器 Python 配置。'));});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`文档处理失败：${error.split('\n').filter(Boolean).at(-1)||'请检查附件格式'}`));});
  });
  return JSON.parse(readFileSync(result,'utf8'));
}
