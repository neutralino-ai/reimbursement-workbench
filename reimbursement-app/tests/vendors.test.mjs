import test from 'node:test';
import assert from 'node:assert/strict';
import {recordSourceCurrent,workspaceVendors} from '../src/vendors.ts';
const now=Date.parse('2026-09-21T12:00:00Z');
const record=(vendor,id)=>({vendor,materials:[{id,role:'invoice',integrity:'ok'}]});
const source=(id,evidenceIDs)=>({id,status:'complete',checkedAt:'2026-09-21T11:00:00Z',evidenceIDs});

test('collection freshness is vendor-specific and covers this account invoice',()=>{
  const gpt=record('chatgpt','gpt-invoice'),first=record('claude','first-invoice'),second=record('claude','second-invoice');
  const data={sources:[source('chatgpt',['gpt-invoice']),source('claude',['first-invoice'])]};
  assert.equal(recordSourceCurrent(gpt,data,7,now),true);
  assert.equal(recordSourceCurrent(first,data,7,now),true);
  assert.equal(recordSourceCurrent(second,data,7,now),false);
  data.sources[1].evidenceIDs.push('second-invoice');
  assert.equal(recordSourceCurrent(second,data,7,now),true);
  data.sources[1].checkedAt='2026-08-01T00:00:00Z';
  assert.equal(recordSourceCurrent(second,data,7,now),false);
  assert.equal(recordSourceCurrent(gpt,data,7,now),true);
});

test('workspace labels include Claude without renaming ChatGPT records',()=>{
  assert.equal(workspaceVendors([record('chatgpt','a'),record('claude','b'),record('claude','c')]),'ChatGPT / Claude');
  assert.equal(workspaceVendors([]),'订阅费用');
});
