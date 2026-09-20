import test from 'node:test';
import assert from 'node:assert/strict';
import {hasImageThumbnail, inspectPreview, previewZoom, readPreview} from '../src/attachment-preview.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
test('local pending previews use the original bytes without any remote request',async()=>{
  const file=new File([png],'selected.png',{type:'application/octet-stream'});let calls=0;
  const result=await readPreview({file},async()=>{calls++;throw new Error('must not upload or fetch');},new AbortController().signal);
  assert.equal(calls,0);assert.equal(result.kind,'image');assert.equal(result.blob.type,'image/png');assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),png);
});
test('uploaded previews read only the selected authenticated attachment and retain its bytes',async()=>{
  const controller=new AbortController(),calls=[];
  const result=await readPreview({href:'/api/materials/selected'},async(href,signal)=>{calls.push(href);assert.equal(signal,controller.signal);return new Blob([png]);},controller.signal);
  assert.deepEqual(calls,['/api/materials/selected']);assert.equal(result.kind,'image');assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),png);
});
test('preview detection supports supported raster formats and PDF regardless of inaccurate MIME',async()=>{
  for(const [content,kind,mime] of [[Buffer.from([255,216,255,224]),'image','image/jpeg'],['GIF89a123456','image','image/gif'],['RIFF1234WEBP1234','image','image/webp'],['%PDF-1.7\nsynthetic','pdf','application/pdf']]){
    const result=await inspectPreview(new Blob([content],{type:'text/html'}));assert.equal(result.kind,kind);assert.equal(result.blob.type,mime);
  }
});
test('HTML, SVG, renamed executable data and unsupported HEIC never become inline documents',async()=>{
  for(const data of ['<script>alert(1)</script>','<svg onload="alert(1)"></svg>','MZ fake.png','\0\0\0\x18ftypheic','', '%PDF-']){
    const result=await inspectPreview(new Blob([data],{type:'image/png'}));assert.equal(result.kind,'unsupported');assert.equal(result.blob.type,'application/octet-stream');
  }
});
test('closing a preview before or during a read cannot return a stale preview',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(readPreview({href:'/api/materials/private'},async()=>{calls++;return new Blob([png]);},controller.signal),{name:'AbortError'});assert.equal(calls,0);
  const next=new AbortController();
  await assert.rejects(readPreview({href:'/api/materials/private'},async()=>{next.abort();return new Blob([png]);},next.signal),{name:'AbortError'});
});
test('failed authenticated reads remain failures instead of rendering a login/error response',async()=>{
  await assert.rejects(readPreview({href:'/api/materials/private'},async()=>{throw new Error('请先登录');},new AbortController().signal),/请先登录/);
});
test('zoom remains usable for fitted large images and is bounded at 5 to 400 percent',()=>{
  assert.equal(previewZoom(0.25,1.5),0.375);assert.equal(previewZoom(1,1.5),1.5);assert.equal(previewZoom(4,1.5),4);assert.equal(previewZoom(0.05,1/1.5),0.05);
});
test('only supported image filenames request thumbnails; PDF and HEIC have a clear file entry',()=>{
  for(const filename of ['图片.PNG','receipt.jpeg','a.gif','a.webp'])assert.equal(hasImageThumbnail(filename),true);
  for(const filename of ['a.pdf','a.heic','a.svg','a.html','a.png.html'])assert.equal(hasImageThumbnail(filename),false);
});
