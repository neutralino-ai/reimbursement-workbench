export type PreparedUpload={file:File;note:string;originalBytes:number};

const imageExtension=/\.(png|jpe?g|webp|gif|heic)$/i;
const jpegConvertible=/\.(png|jpe?g|webp)$/i;
const smallEnough=350*1024;
const maxSide=3000;

function jpegBlob(canvas:HTMLCanvasElement,quality:number):Promise<Blob>{
  return new Promise((resolve,reject)=>{
    const timer=window.setTimeout(()=>reject(new Error('图片压缩超时，请换一张较小的图片。')),20000);
    canvas.toBlob(blob=>{window.clearTimeout(timer);if(blob&&blob.type==='image/jpeg')resolve(blob);else reject(new Error('设备无法生成 JPEG 图片。'));},'image/jpeg',quality);
  });
}

export async function prepareUpload(file:File):Promise<PreparedUpload>{
  if(!imageExtension.test(file.name))return {file,note:'',originalBytes:file.size};
  // GIF may contain several frames and HEIC may contain multiple images. A canvas
  // export would silently discard those pages, so keep their already compressed bytes.
  if(!jpegConvertible.test(file.name))return {file,note:'',originalBytes:file.size};
  if(file.size<=smallEnough)return {file,note:'',originalBytes:file.size};
  const url=URL.createObjectURL(file),image=new Image();
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=window.setTimeout(()=>reject(new Error('图片读取超时，请换一张较小的图片。')),20000);
      image.onload=()=>{window.clearTimeout(timer);resolve();};
      image.onerror=()=>{window.clearTimeout(timer);reject(new Error('无法读取图片，请转换为 PNG 或 JPEG 后重试。'));};
      image.src=url;
    });
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('图片尺寸无效。');
    const ratio=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
    const context=canvas.getContext('2d');if(!context)throw new Error('设备无法压缩图片。');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    let blob=await jpegBlob(canvas,0.88);
    if(blob.size>1.5*1024*1024&&file.size>2*1024*1024)blob=await jpegBlob(canvas,0.80);
    canvas.width=0;canvas.height=0;
    if(blob.size>=file.size*0.9)return {file,note:'',originalBytes:file.size};
    const filename=file.name.replace(/\.[^.]+$/,'')+'.jpg';
    const compressed=new File([blob],filename,{type:'image/jpeg',lastModified:file.lastModified});
    const note=`用户选择 ${file.name}（${file.size} 字节），客户端压缩为 JPEG ${compressed.size} 字节后上传；原图未上传或留存，请以压缩图核验。`;
    return {file:compressed,note,originalBytes:file.size};
  }finally{image.src='';URL.revokeObjectURL(url);}
}
