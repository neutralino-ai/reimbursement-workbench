import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workflowFixture} from './fixtures/workflow-ui.mjs';

test('rendered workflow preserves all individual stages and a direct required-supplement entry',async t=>{
  const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true,hmr:false,watch:null},appType:'custom'});
  t.after(()=>vite.close());
  const {default:WorkflowView}=await vite.ssrLoadModule('/src/WorkflowView.tsx');
  const render=data=>renderToStaticMarkup(createElement(WorkflowView,{data,onReload:async()=>data,onOpenRecord(){},onOpenMaterials(){},onOpenARP(){}}));
  const html=render(workflowFixture());
  const table=html.match(/<table class="ov-table ov-single-table">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table,'the individual workflow must render as a table');
  assert.equal((table.match(/scope="col"/g)||[]).length,6,'expense identity plus all five stages');
  const rows=[...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(1).map(m=>m[1]);
  assert.equal(rows.length,2);
  for(const row of rows){assert.equal((row.match(/scope="row"/g)||[]).length,1);assert.equal((row.match(/<td /g)||[]).length,5);}
  assert.equal((rows.find(r=>r.includes('SINGLE-OPEN')).match(/is-current/g)||[]).length,1);
  assert.equal((rows.find(r=>r.includes('SINGLE-COMPLETE')).match(/is-current/g)||[]).length,0);
  const merge=html.match(/<section[^>]*aria-label="合并报销进度"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(merge?.includes('>上传说明</button>'),'required explanation has an action in the merged area');
  assert.match(merge,/ov-merge-current[\s\S]*需上传领导签字的非单位抬头情况说明[\s\S]*>上传说明<\/button>/);
  assert.ok(!render(workflowFixture({nonUnit:false})).includes('>上传说明</button>'),'no extra requirement is invented for unflagged packages');
});
