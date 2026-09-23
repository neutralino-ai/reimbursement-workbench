import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {apiFetch} from './api';
import {AuthenticatedImage} from './AuthenticatedFiles';
import ActionButton from './ActionButton';
import {isIOS, presentMobileFile} from './mobile';
import {hasImageThumbnail, previewZoom, readPreview, type PreviewKind} from './attachment-preview';
import './attachment-preview.css';

type Props = {file: File; href?: never; filename?: never} | {file?: never; href: string; filename: string};

function LocalThumbnail({file}: {file: File}) {
  const [url, setURL] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(file); setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <img src={url || undefined} alt="" className="attachment-thumbnail" />;
}

export default function AttachmentPreview(props: Props) {
  const [open, setOpen] = useState(false);
  const filename = props.file?.name ?? props.filename!;
  return <>
    <button type="button" className="attachment-preview-trigger" aria-label={'预览 '+filename} onClick={() => setOpen(true)}>
      {hasImageThumbnail(filename) ? props.file ? <LocalThumbnail file={props.file}/> : <AuthenticatedImage src={props.href!} alt="" className="attachment-thumbnail"/> : <span className="attachment-file-icon" aria-hidden="true">{/\.pdf$/i.test(filename) ? 'PDF' : '文件'}</span>}
      <span className="attachment-preview-label"><span>{filename}</span><small>点击预览</small></span>
    </button>
    {open && createPortal(<PreviewDialog {...props} onClose={() => setOpen(false)}/>, document.body)}
  </>;
}

function PreviewDialog({file, href, filename: remoteName, onClose}: Props & {onClose: () => void}) {
  const filename = file?.name ?? remoteName!;
  const dialog = useRef<HTMLDialogElement>(null), image = useRef<HTMLImageElement>(null);
  const [preview, setPreview] = useState<{url: string; blob: Blob; kind: PreviewKind} | null>(null);
  const [error, setError] = useState(''), [imageError, setImageError] = useState(false);
  const [scale, setScale] = useState<number | null>(null), [natural, setNatural] = useState({width: 0, height: 0});
  const [retry, setRetry] = useState(0), [opening, setOpening] = useState(false);
  useEffect(() => {
    const target = dialog.current!, previous = document.activeElement as HTMLElement | null;
    target.showModal();
    return () => { target.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let url: string | undefined;
    setPreview(null); setError(''); setImageError(false); setScale(null); setNatural({width: 0, height: 0});
    void (async () => {
      try {
        const source = file ? {file} : {href: href!};
        const loaded = await readPreview(source, async (path, signal) => (await apiFetch(path, {signal: AbortSignal.any([signal, AbortSignal.timeout(60000)])})).blob(), controller.signal);
        url = URL.createObjectURL(loaded.blob);
        setPreview({...loaded, url});
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '预览加载失败，请重试。');
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file, href, retry]);
  function zoom(factor: number) {
    const current = scale ?? (image.current && natural.width ? image.current.clientWidth / natural.width : 1);
    setScale(previewZoom(current, factor));
  }
  async function openMobilePDF() {
    if (!preview || opening) return;
    setOpening(true); setError('');
    try { await presentMobileFile(preview.blob, filename, false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开 PDF。'); }
    finally { setOpening(false); }
  }
  const displayImage = preview?.kind === 'image' && !imageError;
  return <dialog ref={dialog} className="attachment-preview-dialog" aria-label={'附件预览：'+filename} onCancel={event => {event.preventDefault();event.stopPropagation();onClose();}} onKeyDown={event => {if (event.key === 'Escape') event.stopPropagation();}}>
    <header><div><strong>附件预览</strong><span>{filename}</span></div><button type="button" className="button secondary" autoFocus onClick={onClose}>关闭预览</button></header>
    {displayImage && <div className="attachment-preview-tools" aria-label="图片缩放">
      <ActionButton className="button secondary small" reason={!natural.width?'图片正在加载，请稍候。':scale===0.05?'已缩小到最小比例（5%）。':''} onClick={() => zoom(1 / 1.5)}>缩小</ActionButton>
      <output aria-live="polite">{scale === null ? '适应窗口' : Math.round(scale * 100)+'%'}</output>
      <ActionButton className="button secondary small" reason={!natural.width?'图片正在加载，请稍候。':scale===4?'已放大到最大比例（400%）。':''} onClick={() => zoom(1.5)}>放大</ActionButton>
      <button type="button" className="text-button" onClick={() => setScale(null)}>适应窗口</button>
      <ActionButton className="text-button" reason={!natural.width?'图片正在加载，请稍候。':''} onClick={() => setScale(1)}>原始尺寸</ActionButton>
    </div>}
    <div className={'attachment-preview-viewport'+(scale === null ? ' is-fit' : '')}>
      {!preview && !error && <p role="status">正在读取附件…</p>}
      {displayImage && <img ref={image} src={preview.url} alt={filename+' 完整预览'} onLoad={event => setNatural({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} onError={() => setImageError(true)} style={scale !== null && natural.width ? {width: natural.width * scale, height: natural.height * scale} : undefined}/>}
      {preview?.kind === 'pdf' && <div className="attachment-preview-fallback"><strong>PDF 原件</strong><p>在独立预览中查看全部页面，可翻页和缩放。</p>{isIOS() ? <ActionButton className="button primary" reason={opening?'正在打开 PDF 预览，请稍候。':''} onClick={() => void openMobilePDF()}>打开 PDF 预览</ActionButton> : <a className="button primary" href={preview.url} target="_blank" rel="noopener noreferrer">打开 PDF 预览</a>}</div>}
      {preview && (preview.kind === 'unsupported' || imageError) && <div className="attachment-preview-fallback"><strong>当前设备无法直接预览此文件</strong><p>可下载原件，用系统预览打开后再决定是否删除。文件尚未被移除。</p><a className="button secondary" href={preview.url} download={filename}>下载原件</a></div>}
      {error && <div className="attachment-preview-fallback"><p className="feedback error" role="alert">{error}</p><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>重新加载</button></div>}
    </div>
    <footer>{file ? '本地预览，尚未上传。关闭后可移除选错的文件。' : '正在查看已上传的原件。关闭后可返回附件列表决定是否删除。'}</footer>
  </dialog>;
}
