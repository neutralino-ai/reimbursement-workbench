import {useEffect, useId, useRef, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes, type MouseEvent} from 'react';
import {apiFetch} from './api';
import {isIOS,presentMobileFile} from './mobile';
import './action-button.css';

type FileLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'download' | 'onClick' | 'target' | 'rel'> & {
  href: string;
  filename?: string;
  download?: boolean | string;
};

async function checkedBlob(response: Response): Promise<Blob> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `读取文件失败（${response.status}）`);
  }
  return response.blob();
}

function responseFilename(response: Response): string | undefined {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* Use the plain filename if available. */ }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
}

export function AuthenticatedFileLink({href, filename, download, children, ...props}: FileLinkProps) {
  const [busy, setBusy] = useState(false);
  const [activity,setActivity]=useState('');
  const activityID=useId();
  const [error, setError] = useState('');
  const active = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const resources = useRef(new Map<string, number>());
  const pendingWindows = useRef(new Set<Window>());

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
      for (const popup of pendingWindows.current) popup.close();
      pendingWindows.current.clear();
      for (const [url, timer] of resources.current) {
        window.clearInterval(timer);
        URL.revokeObjectURL(url);
      }
      resources.current.clear();
    };
  }, []);

  function release(url: string) {
    window.clearInterval(resources.current.get(url));
    resources.current.delete(url);
    URL.revokeObjectURL(url);
  }

  async function openFile(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (requests.current.size) return;
    const controller = new AbortController();
    requests.current.add(controller);
    setBusy(true); setError('');setActivity('正在下载附件，请稍候…');
    const isDownload = download !== undefined && download !== false;
    let popup: Window | null = null;
    let objectURL: string | undefined;
    try {
      if (!isDownload && !isIOS()) {
        // Open during the click, then sever the opener before any file is loaded.
        // Passing the noopener window feature would discard the navigation handle.
        popup = window.open('about:blank', '_blank');
        if (!popup) throw new Error('浏览器阻止了预览窗口，请允许此站点打开弹窗后重试。');
        popup.opener = null;
        popup.document.title = '正在读取附件…';
        pendingWindows.current.add(popup);
      }
      const fragmentIndex = href.indexOf('#');
      const path = fragmentIndex < 0 ? href : href.slice(0, fragmentIndex);
      const fragment = fragmentIndex < 0 ? '' : href.slice(fragmentIndex);
      const response = await apiFetch(path, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])});
      const blob = await checkedBlob(response);
      if (controller.signal.aborted || !active.current) return;
      setActivity(isDownload?'正在准备保存文件，请稍候…':'正在打开附件预览，请稍候…');
      if (isIOS()) {
        const nativeName = typeof download === 'string' && download || filename || responseFilename(response) || (blob.type === 'application/pdf' ? '附件.pdf' : '附件');
        await presentMobileFile(blob, nativeName, isDownload);
        return;
      }
      objectURL = URL.createObjectURL(blob);
      // Never navigate to a potentially executable HTML or SVG attachment on the app origin.
      const previewable = /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon))$/i.test(blob.type.split(';')[0].trim());
      if (popup && previewable) {
        if (popup.closed) { pendingWindows.current.delete(popup); release(objectURL); return; }
        popup.location.replace(`${objectURL}${fragment}`);
        pendingWindows.current.delete(popup);
        const preview = popup;
        const url = objectURL;
        resources.current.set(url, window.setInterval(() => { if (preview.closed) release(url); }, 1000));
      } else {
        popup?.close();
        if (popup) pendingWindows.current.delete(popup);
        const link = document.createElement('a');
        link.href = objectURL;
        link.download = typeof download === 'string' && download || filename || responseFilename(response) || '附件';
        link.rel = 'noopener noreferrer';
        document.body.append(link);
        link.click();
        link.remove();
        const url = objectURL;
        // Allow the browser to consume the Blob before releasing the download URL.
        resources.current.set(url, window.setInterval(() => release(url), 60000));
      }
    } catch (failure) {
      popup?.close();
      if (popup) pendingWindows.current.delete(popup);
      if (objectURL) release(objectURL);
      if (!controller.signal.aborted && active.current) setError(failure instanceof Error ? failure.message : '读取文件失败。');
    } finally {
      requests.current.delete(controller);
      if (active.current) setBusy(false);
    }
  }

  return <><a {...props} href="#" rel="noopener noreferrer" aria-busy={busy} aria-disabled={busy} aria-describedby={[props['aria-describedby'],busy?activityID:undefined].filter(Boolean).join(' ')||undefined} onClick={event => void openFile(event)} onAuxClick={event => { if (event.button === 1) void openFile(event); }}>{children}{busy&&<span id={activityID} className="file-transfer-status" role="status">{activity}</span>}</a>{error && <span className="feedback error" role="alert">{error}</span>}</>;
}

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & {src: string};

export function AuthenticatedImage({src, alt, ...props}: ImageProps) {
  const [image, setImage] = useState<{source: string; url: string} | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectURL: string | undefined;
    setError('');
    void (async () => {
      try {
        const blob = await checkedBlob(await apiFetch(src, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])}));
        if (controller.signal.aborted) return;
        objectURL = URL.createObjectURL(blob);
        setImage({source: src, url: objectURL});
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '图片读取失败。');
      }
    })();
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [src]);
  if (error) return <span className="feedback error" role="alert">{alt ? `${alt}：` : ''}{error}</span>;
  return <img {...props} src={image?.source === src ? image.url : undefined} alt={alt} aria-busy={image?.source !== src} />;
}
