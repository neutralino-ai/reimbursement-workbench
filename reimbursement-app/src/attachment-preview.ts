export type PreviewSource = {file: Blob; href?: never} | {file?: never; href: string};
export type PreviewKind = 'image' | 'pdf' | 'unsupported';

// Inspect the bytes, not a filename or an untrusted server MIME, before opening
// a Blob on the application origin. HTML and SVG never become inline previews.
export async function inspectPreview(blob: Blob): Promise<{kind: PreviewKind; blob: Blob}> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  let mime = '';
  if (starts(137,80,78,71,13,10,26,10)) mime = 'image/png';
  else if (starts(255,216,255)) mime = 'image/jpeg';
  else if (['GIF87a','GIF89a'].includes(text(0,6))) mime = 'image/gif';
  else if (text(0,4) === 'RIFF' && text(8,12) === 'WEBP') mime = 'image/webp';
  else if (/^%PDF-\d\.\d/.test(text(0,8))) mime = 'application/pdf';
  return {kind: mime === 'application/pdf' ? 'pdf' : mime ? 'image' : 'unsupported', blob: blob.slice(0, blob.size, mime || 'application/octet-stream')};
}

export async function readPreview(source: PreviewSource, readRemote: (href: string, signal: AbortSignal) => Promise<Blob>, signal: AbortSignal) {
  signal.throwIfAborted();
  const blob = source.file ?? await readRemote(source.href!, signal);
  const result = await inspectPreview(blob);
  signal.throwIfAborted();
  return result;
}

export function previewZoom(current: number, factor: number) {
  return Math.min(4, Math.max(0.05, current * factor));
}

export function hasImageThumbnail(filename: string) {
  return /\.(png|jpe?g|webp|gif)$/i.test(filename);
}
