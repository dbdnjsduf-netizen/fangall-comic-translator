import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as policy from '../lib/analysis-policy.mjs';
import { responseEvents } from '../lib/response-stream.mjs';
const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const section = (a,b) => { const start=source.indexOf(a), end=source.indexOf(b,start); assert.ok(start>=0 && end>start, a); return source.slice(start,end); };
const good = () => ({ audit: { visible_occurrence_count: 1, coverage_confidence: 'high', reading_order_confidence: 'high', needs_review: false, review_reason: '', corrections_made:false, audit_summary:'' }, reading_order: [{source_text:'こんにちは',translated_text:'안녕',container_type:'speech',text_color_hint:'none',page_zone:'top-left',source_confidence:'high',translation_confidence:'high',needs_review:false,review_reason:''}] });
function setup(responses = []) {
  const requests=[];
  const c=vm.createContext({ ...policy, responseEvents, process:{env:{MODEL_STAGE_MAX_RETRIES:'0'}}, console:{log(){},warn(){}}, Set, Map, Buffer, AbortSignal, TextDecoder,
    activeOauthUrl:'http://mock.invalid', fetch:async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const next=responses.shift();
      if (next?.image) return new Response(JSON.stringify({output:[{type:'image_generation_call',result:Buffer.from('image').toString('base64')}]}), {headers:{'content-type':'application/json'}});
      return new Response('data: '+JSON.stringify({type:'response.output_text.done',text:JSON.stringify(next || good())})+'\r\n\r\n', {headers:{'content-type':'text/event-stream'}});
    }});
  vm.runInContext(section('const AUTOMATIC_MODEL_PIPELINE','app.use(express.json'),c);
  vm.runInContext(section('async function fetchOAuth(', 'async function postprocessOutputBuffer('),c);
  vm.runInContext(section('function normalizeGenerationAdditionalRequest(', 'function normalizeEditableString('),c);
  return {c,requests};
}
test('actual server request uses low, audited schema, dictionary, and a full-page image',async()=>{
  const {c,requests}=setup();
  const result=await vm.runInContext(`runAutomaticOcrTranslation('data:image/png;base64,FAKE',getPreset('manga_jp'),['猫 => 고양이'],()=>{},'sol_adaptive')`,c);
  assert.equal(requests.length,1);
  assert.equal(requests[0].model,'gpt-6-sol');
  assert.equal(requests[0].reasoning.effort,'low');
  assert.ok(requests[0].text.format.schema.properties.audit);
  assert.ok(requests[0].input[1].content.some(x=>x.type==='input_image' && x.detail==='high'));
  assert.match(JSON.stringify(requests[0].input),/猫 => 고양이/);
  assert.equal(result.reading_order[0].item_id,'T01');
});
test('actual escalation request uses high and permits recovering omitted text',async()=>{
  const bad=good(); bad.audit.needs_review=true; bad.audit.review_reason='누락 가능';
  const {c,requests}=setup([bad,good()]);
  await vm.runInContext(`runAutomaticOcrTranslation('FAKE',getPreset('comic'),[],()=>{},'sol_adaptive')`,c);
  assert.deepEqual(requests.map(x=>x.model),['gpt-6-sol','gpt-6-sol']);
  assert.deepEqual(requests.map(x=>x.reasoning.effort),['low','high']);
  assert.match(JSON.stringify(requests[1].input),/not present in the draft/);
  assert.match(JSON.stringify(requests[1].input),/누락 가능/);
});
test('new Korean clarity applies once to every active image prompt path',async()=>{
  for(const preset of ['comic','manga_jp','document','cardgame']) for(const mode of ['page','protected_mask','painted_mask']) {
    const {c,requests}=setup([{image:true}]);
    c.translation={...good(),blocks:[{text:'문서'}]};
    await vm.runInContext(`runImageTranslation('FAKE',translation,'2048x2048',getPreset('${preset}'),[],'gpt-5.6-terra',null,${mode==='painted_mask'},'${mode}')`,c);
    assert.equal(requests[0].model,'gpt-6-sol');
    assert.equal(requests[0].reasoning.effort,'medium');
    const text=requests[0].input.flatMap(x=>x.content).filter(x=>x.type==='input_text').map(x=>x.text).join('\n');
    assert.equal(text.split('KOREAN LETTERING CLARITY:').length-1,1,preset+' '+mode);
    assert.match(text,/Do not imitate low source resolution/);
    assert.match(text,/typeface character/);
    assert.match(text,/protected Latin glyphs untouched/);
    assert.match(text,/edit ONLY the written text inside it/);
    assert.match(text,/Every other interior pixel remains unchanged/);
    assert.match(text,/user styling requests never authorize changing the balloon/);
  }
});
test('request IDs do not make permanent HTTP failures retryable',()=>{
  const {c}=setup();
  assert.equal(vm.runInContext(`isTransientModelError({status:400,message:'invalid request (request id: a)'})`,c),false);
  assert.equal(vm.runInContext(`isTransientModelError({status:429,message:'rate limit'})`,c),true);
  assert.equal(vm.runInContext(`isTransientModelError({status:503,message:'server unavailable'})`,c),true);
});
