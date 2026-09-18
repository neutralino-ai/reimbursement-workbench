import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {extractPayment,comparePayment} from '../server/payment-precheck.mjs';

const args=process.argv.slice(2);
const option=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:args[index+1];};
if(args.includes('--help')){console.log('node scripts/review-payment.mjs --input /private/inputs.json --env-file /private/env.txt --output-dir /private/results [--model deepseek-flash] [--base-url https://api.deepseek.com]');process.exit(0);}
const input=option('--input'),envFile=option('--env-file'),output=option('--output-dir');
if(!input||!envFile||!output)throw new Error('需要 --input、--env-file 和 --output-dir；使用 --help 查看说明');
if(statSync(envFile).size>65536)throw new Error('环境配置文件过大');
const secretMatches=[...readFileSync(envFile,'utf8').matchAll(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*[:=]\s*["']?([^\s"']+)["']?\s*$/gm)];
if(secretMatches.length!==1)throw new Error('env 文件须有且仅有一行 DEEPSEEK_API_KEY=...');
const apiKey=secretMatches[0][1];
const inputs=JSON.parse(readFileSync(input,'utf8'));
if(!Array.isArray(inputs)||inputs.length<1||inputs.length>10)throw new Error('一次本地测试只允许 1–10 张凭证');
mkdirSync(output,{recursive:true,mode:0o700});
const reports=[];
for(const item of inputs){
  if(!path.isAbsolute(item.localPath)||!item.record?.id||!item.material?.sha256)throw new Error('输入须含原件绝对路径、记录和 SHA256');
  const bytes=readFileSync(item.localPath);
  if(createHash('sha256').update(bytes).digest('hex')!==item.material.sha256)throw new Error('原件哈希已变化');
  const result=await extractPayment({bytes,apiKey,model:option('--model','deepseek-flash'),baseURL:option('--base-url','https://api.deepseek.com')});
  const duplicateImage=inputs.some(other=>other.record.id!==item.record.id&&other.material.sha256===item.material.sha256);
  const report={recordID:item.record.id,recordVersion:item.record.version,invoiceNumber:item.record.invoiceNumber,materialID:item.material.id,at:new Date().toISOString(),...result,comparison:comparePayment(result.extraction,item.record,{duplicateImage}),mode:'local-test',businessStateChanged:false};
  writeFileSync(path.join(output,item.material.sha256+'.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  reports.push(report);
  console.log(JSON.stringify({invoice:report.invoiceNumber,status:report.comparison.status,model:report.model,elapsedMs:report.elapsedMs,usage:report.usage}));
}
writeFileSync(path.join(output,'reports.json'),JSON.stringify(reports,null,2)+'\n',{mode:0o600});
