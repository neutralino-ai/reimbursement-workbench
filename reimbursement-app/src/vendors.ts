import type {RecordItem, Workspace} from './types';
import {sourceFreshness} from './workflow.ts';

export const vendorLabel = (vendor: string) => ({chatgpt: 'ChatGPT', claude: 'Claude'}[vendor] || vendor || '订阅服务');
export const workspaceVendors = (records: RecordItem[]) => [...new Set(records.map(record => vendorLabel(record.vendor)))].join(' / ') || '订阅费用';
export function recordSourceCurrent(record: RecordItem, data: Workspace, days = 7, now = Date.now()) {
  const source = data.sources.find(item => item.id === record.vendor);
  return source?.status === 'complete' && sourceFreshness(source, days, now).fresh
    && record.materials.some(material => material.role === 'invoice' && material.integrity === 'ok' && source.evidenceIDs?.includes(material.id));
}
