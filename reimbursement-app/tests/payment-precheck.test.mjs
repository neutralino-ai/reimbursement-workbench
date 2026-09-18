import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePayment,extractPayment} from '../server/payment-precheck.mjs';
const record={amount:'42.50',currency:'USD',date:'2026-03-12'};
const extraction=()=>({documentType:'payment',transactions:[{merchant:'OpenAI *ChatGPT Subscr',amount:'42.50',currency:'USD',transactionDate:'2026-03-12',status:'completed',cardLast4:'1234',evidence:{merchant:'OpenAI *ChatGPT Subscr',amount:'US$42.50',currency:'US$',date:'2026/3/12',status:'已结算'}}],warnings:[]});
test('payment precheck matches fields without asserting human verification or approval',()=>{
 const result=comparePayment(extraction(),record);assert.equal(result.status,'matched');assert.equal(result.humanVerified,false);
 const changed=extraction();changed.documentType='invoice';assert.equal(comparePayment(changed,record).status,'needs_review');
});
test('wrong merchant, amount, currency, month, refunds and duplicate originals cannot pass',()=>{
 for(const patch of [{merchant:'Different Shop'},{amount:'2.00'},{currency:'CNY'},{transactionDate:'2026-04-12'},{status:'pending'},{status:'refunded'},{status:'reversed'}]){
  const data=extraction();Object.assign(data.transactions[0],patch);assert.equal(comparePayment(data,record).status,'mismatch');
 }
 assert.equal(comparePayment(extraction(),record,{duplicateImage:true}).status,'mismatch');
});
test('missing evidence, invalid dates, warnings and multiple transactions need review',()=>{
 const data=extraction();data.transactions[0].evidence.currency=null;assert.equal(comparePayment(data,record).status,'needs_review');
 for(const patch of [{currency:null},{transactionDate:'2026-02-31'},{status:'unknown'}]){const d=extraction();Object.assign(d.transactions[0],patch);assert.equal(comparePayment(d,record).status,'needs_review');}
 const multi=extraction();multi.transactions.push({...multi.transactions[0]});assert.equal(comparePayment(multi,record).status,'needs_review');
 const warn=extraction();warn.warnings=['金额被遮挡'];assert.equal(comparePayment(warn,record).status,'needs_review');
});
test('Responses uses image input, non-streaming schema extraction and no bank facts in the prompt',async()=>{
 const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
 let request;
 const result=await extractPayment({bytes,apiKey:'synthetic-test-key',fetchImpl:async(url,options)=>{assert.equal(url,'https://api.deepseek.com/responses');request=JSON.parse(options.body);return Response.json({status:'completed',model:'synthetic',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction())}]}]});}});
 assert.equal(request.stream,false);assert.equal(request.store,false);assert.equal(request.text.format.type,'json_schema');assert.equal(request.tools,undefined);assert.equal(request.input[0].content[1].type,'input_image');assert.equal(result.extraction.transactions[0].amount,'42.50');
 for(const response of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}])await assert.rejects(extractPayment({bytes,apiKey:'synthetic-test-key',fetchImpl:async()=>Response.json(response)}));
 await assert.rejects(extractPayment({bytes:Buffer.from('%PDF'),apiKey:'synthetic-test-key'}),/PNG/);
});
