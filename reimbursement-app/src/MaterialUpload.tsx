import { useRef, useState } from 'react';
import { api } from './api';
import type { RecordItem, Workspace } from './types';

export default function MaterialUpload({ record, role, onReload, onBusy, disabled = false }: {
  record: RecordItem;
  role: 'invoice' | 'payment' | 'purposeEvidence';
  onReload: () => Promise<Workspace>;
  onBusy: (value: boolean) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const label = role === 'payment' ? '付款截图或 PDF' : role==='purposeEvidence' ? '用途截图或 PDF' : '发票 PDF 或图片';
  async function upload(file: File) {
    setError(''); setSuccess('');
    if (!file.size || file.size > 20 * 1024 * 1024) { setError('请选择 20 MB 以内的文件。'); if (input.current) input.current.value = ''; return; }
    if (!/\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(file.name)) { setError('请选择图片或 PDF。'); if (input.current) input.current.value = ''; return; }
    setBusy(true); onBusy(true);
    let saved = false;
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'));
        reader.readAsDataURL(file);
      });
      await api(`/api/records/${encodeURIComponent(record.id)}/materials`, {
        method: 'POST', body: JSON.stringify({ filename: file.name, role, contentBase64, baseVersion: record.version }),
      });
      saved = true;
      await onReload();
      setSuccess(role==='purposeEvidence'?'用途原件已保存。':'原件已保存；启用自动核验后服务器将继续处理。');
    } catch (failure) {
      setError(saved ? '文件已保存，台账刷新失败。请刷新后查看。' : failure instanceof Error ? failure.message : '上传失败。');
    } finally { setBusy(false); onBusy(false); if (input.current) input.current.value = ''; }
  }
  return <div className="material-upload">
    <input className="sr-only" ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic" aria-label={`选择${label}`} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} disabled={busy} />
    <button type="button" className="button secondary" disabled={busy || disabled || !record.version} onClick={() => input.current?.click()}>{busy ? '保存中…' : `上传${label}`}</button>
    {error && <p className="feedback error" role="alert">{error}</p>}
    {success && <p className="feedback success" role="status">{success}</p>}
  </div>;
}
