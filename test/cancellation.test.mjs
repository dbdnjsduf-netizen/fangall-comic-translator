import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { cancelQueuedItems, batchCompletionStatus } from '../lib/batch-cancellation.mjs';

test('cancel only pending work across batches, release buffers, and preserve started data', () => {
  const running = { id:'started',status:'running',translation:{reading_order:[]},buffer:Buffer.from('data') };
  const batches = [{items:[running,{id:'q',status:'queued',buffer:Buffer.from('waiting')}]},{items:[{id:'done',status:'completed'},{id:'q',status:'queued'}]}];
  const result=cancelQueuedItems(batches,123);
  assert.equal(result.cancelledCount,2);
  assert.equal(running.status,'running');
  assert.ok(running.buffer);
  assert.equal(batches[0].items[1].buffer,null);
  assert.equal(batches[1].items[0].status,'completed');
  assert.equal(cancelQueuedItems(batches).cancelledCount,0);
  assert.equal(JSON.parse(JSON.stringify(batches))[0].items[1].status,'cancelled');
});
test('split images keep unstarted half if the other half started', () => {
  const batch={items:[{id:'a',splitGroupId:'started',status:'running'},{id:'b',splitGroupId:'started',status:'queued'},
    {id:'c',splitGroupId:'waiting',status:'queued'},{id:'d',splitGroupId:'waiting',status:'queued'}]};
  assert.equal(cancelQueuedItems([batch]).cancelledCount,1);
  assert.deepEqual(batch.items.map(i=>i.status),['running','queued','cancelled','cancelled']);
});
test('cancelled completion is distinct from failures and mixed completion', () => {
  const status=(...statuses)=>batchCompletionStatus(statuses.map(status=>({status})));
  assert.equal(status('running','cancelled'),'running');
  assert.equal(status('cancelled','cancelled'),'cancelled');
  assert.equal(status('completed','cancelled'),'completed_with_cancellations');
  assert.equal(status('failed','cancelled'),'completed_with_errors');
});
test('real batch workers finish started analysis and generation but skip cancelled items',async()=>{
  const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function processBatch('),end=source.indexOf('function getBatchItem(',start);
  const generated=[];
  let unblock;
  let bothStarted;
  let analysisCount=0;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const started=new Promise(resolve=>{bothStarted=resolve;});
  const c=vm.createContext({Buffer,console:{log(){}},batchCompletionStatus,TMP_DIR:'tmp',RESTORE_SOURCE_DIR:'restore',ANALYSIS_CONCURRENCY:2,IMAGE_GENERATION_CONCURRENCY:2,MODEL_CONCURRENCY_LIMIT:4,
    join:(...p)=>p.join('/'), normalizeDictionary:()=>[], getPreset:()=>({id:'comic'}),
    updateItemPhase:(_b,i,status,label,progress)=>Object.assign(i,{status,phaseLabel:label,progress}),
    writeFile:async()=>{},sharp:()=>({metadata:async()=>({width:100,height:100})}),
    normalizeTargetForPreset:()=>({width:100,height:100,size:'100x100'}),prepareSourceForModels:async b=>b,
    normalizeProtectionSpec:()=>({regions:[]}),mapProtectionToGenerationSpace:()=>({regions:[]}),hasProtectionShapes:()=>false,
    applyProtectionMask:async b=>b,normalizeAnalysisMode:()=> 'sol_adaptive',
    runAutomaticOcrTranslation:async()=>{analysisCount++;if(analysisCount===2)bothStarted();await gate;return {};},
    runImageTranslation:async()=>Buffer.from('generated'),saveOutputs:async(name)=>{generated.push(name);return {downloadPath:name,publicUrl:name,unrestoredBuffer:Buffer.from('raw')};},
    persistBatchState:async()=>{},existsSync:()=>false,finalizeSplitPageOutputs:async()=>{},
  });
  vm.runInContext(source.slice(start,end),c);
  const batch={id:'test',items:Array.from({length:5},(_,i)=>({id:String(i),originalName:String(i),status:'queued',buffer:Buffer.from('image')}))};
  c.batch=batch;
  const processing=vm.runInContext('processBatch(batch)',c);
  await started;
  assert.equal(cancelQueuedItems([batch]).cancelledCount,3);
  unblock();
  await processing;
  assert.equal(analysisCount,2);
  assert.deepEqual(generated.sort(),['0','1']);
  assert.deepEqual(batch.items.map(i=>i.status),['completed','completed','cancelled','cancelled','cancelled']);
  assert.equal(batch.status,'completed_with_cancellations');
});
