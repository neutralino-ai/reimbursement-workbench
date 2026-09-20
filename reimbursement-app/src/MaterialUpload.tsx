import { useRef, useState } from 'react';
import { api } from './api';
import type { Material, RecordItem, Workspace } from './types';

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
  const [selected, setSelected] = useState<File | null>(null);
  const label = role === 'payment' ? '付款截图或 PDF' : role==='purposeEvidence' ? '用途截图或 PDF' : '发票 PDF 或图片';
  const existing = record.materials.filter(material => material.role === role);
  function clearSelection() {
    setSelected(null);
    if (input.current) input.current.value = '';
  }
  function choose(file: File) {
    setError(''); setSuccess('');
    if (!file.size || file.size > 20 * 1024 * 1024) { setError('请选择 20 MB 以内的文件。'); clearSelection(); return; }
    if (!/\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(file.name)) { setError('请选择图片或 PDF。'); clearSelection(); return; }
    setSelected(file);
  }
  async function upload() {
    if (!selected) return;
    setBusy(true); onBusy(true);
    let saved = false;
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'));
        reader.readAsDataURL(selected);
      });
      await api(`/api/records/${encodeURIComponent(record.id)}/materials`, {
        method: 'POST', body: JSON.stringify({ filename: selected.name, role, contentBase64, baseVersion: record.version }),
      });
      saved = true;
      await onReload();
      setSuccess(role==='purposeEvidence'?'用途原件已保存。':'原件已保存；启用自动核验后服务器将继续处理。');
      clearSelection();
    } catch (failure) {
      setError(saved ? '文件已保存，台账刷新失败。请刷新后查看。' : failure instanceof Error ? failure.message : '上传失败。');
    } finally { setBusy(false); onBusy(false); }
  }
  async function remove(material: Material) {
    if (busy || disabled || !record.version) return;
    setBusy(true); onBusy(true); setError(''); setSuccess('');
    let removed = false;
    try {
      await api(`/api/records/${encodeURIComponent(record.id)}/materials/${encodeURIComponent(material.id)}`, {
        method: 'DELETE', body: JSON.stringify({ baseVersion: record.version }),
      });
      removed = true;
      await onReload();
      setSuccess(`已删除误上传的${material.filename}。`);
    } catch (failure) {
      setError(removed ? '材料已删除，但台账刷新失败。请刷新后核对。' : failure instanceof Error ? failure.message : '删除失败。');
    } finally { setBusy(false); onBusy(false); }
  }
  return <div className="material-upload">
    <input className="sr-only" ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic" aria-label={`选择${label}`} onChange={event => { const file = event.target.files?.[0]; if (file) choose(file); }} disabled={busy || disabled} />
    <button type="button" className="button secondary" disabled={busy || disabled || !record.version} onClick={() => input.current?.click()}>选择{label}</button>
    {selected && <div className="material-pending"><span><strong>待上传：</strong>{selected.name}</span><div><button type="button" className="text-button" onClick={clearSelection} disabled={busy}>取消</button><button type="button" className="button primary small" onClick={() => void upload()} disabled={busy}>{busy ? '上传中…' : '提交上传'}</button></div></div>}
    {existing.length > 0 && <div className="material-upload-list"><small>已上传的{role === 'payment' ? '付款凭证' : role === 'purposeEvidence' ? '用途材料' : '发票'}：</small>{existing.map(material => <div className="material-upload-item" key={material.id}><span title={material.filename}>{material.filename}</span><button type="button" className="text-button danger-text" disabled={busy || disabled} onClick={() => void remove(material)}>删除</button></div>)}</div>}
    {error && <p className="feedback error" role="alert">{error}</p>}
    {success && <p className="feedback success" role="status">{success}</p>}
  </div>;
}
