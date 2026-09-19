import test from 'node:test';
import assert from 'node:assert/strict';
import {emptySpeech,receiveSpeech,speechIsActive,appendDictation,mobileFilename} from '../src/speech-state.ts';

test('partial dictation replaces only its scratch text, never appends duplicate partials',()=>{
 let s={...emptySpeech,id:'run-a',phase:'starting'};
 assert.equal(speechIsActive(s),true);
 s=receiveSpeech(s,{id:'run-a',phase:'recording',text:'分析'});
 s=receiveSpeech(s,{id:'run-a',phase:'recording',text:'分析探测器数据'});
 assert.equal(s.text,'分析探测器数据');
 s=receiveSpeech(s,{id:'run-a',phase:'review',text:'分析探测器数据。'});
 assert.equal(speechIsActive(s),false);
 const edited={...s,text:'人工修改后的文字'};
 assert.strictEqual(receiveSpeech(edited,{id:'run-a',phase:'recording',text:'迟到的文字'}),edited);
 assert.equal(appendDictation('已有用途\n保持原样',' 分析探测器数据。 '),'已有用途\n保持原样\n分析探测器数据。');
 assert.equal(appendDictation('已有用途\n','下一段'),'已有用途\n下一段');
 assert.equal(appendDictation('已有用途','  '),'已有用途');
});
test('cancelled and previous runs cannot replace current text or restart a stopped recording',()=>{
 assert.strictEqual(receiveSpeech(emptySpeech,{id:'old',phase:'review',text:'旧内容'}),emptySpeech);
 let s={...emptySpeech,id:'new',phase:'stopping',text:'保留内容'};
 assert.strictEqual(receiveSpeech(s,{id:'old',phase:'review',text:'旧内容'}),s);
 assert.strictEqual(receiveSpeech(s,{id:'new',phase:'recording',text:'迟到部分'}),s);
 s=receiveSpeech(s,{id:'new',phase:'review',text:'完整内容',message:'录音被系统中断'});
 assert.equal(s.phase,'review');assert.equal(s.message,'录音被系统中断');
});
test('mobile export names keep Unicode extensions and cannot escape the preview directory',()=>{
 assert.equal(mobileFilename('../../秘密/发票.pdf'),'发票.pdf');
 assert.equal(mobileFilename('C:\\temp\\用途.docx'),'用途.docx');
 assert.equal(mobileFilename('..\u0000材料.zip'),'材料.zip');
 const shortened=mobileFilename('用途'.repeat(200)+'.pdf');
 assert.ok(Buffer.byteLength(shortened)<=220);assert.ok(shortened.endsWith('.pdf'));
});
