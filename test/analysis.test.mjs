import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisPipeline, normalizeAnalysisMode, countChangedOccurrences } from '../lib/analysis-policy.mjs';
import { responseEvents } from '../lib/response-stream.mjs';

const item = (extra = {}) => ({ source_text: '二人だ', translated_text: '두 명이야', container_type: 'speech', text_color_hint: 'none', page_zone: 'top-right', source_confidence: 'high', translation_confidence: 'high', needs_review: false, review_reason: '', ...extra });
const page = (items = [item()], audit = {}) => ({ reading_order: items, audit: { visible_occurrence_count: items.length, coverage_confidence: 'high', reading_order_confidence: 'high', needs_review: false, review_reason: '', corrections_made: false, audit_summary: '', ...audit } });
async function run(draft, final = page(), mode = 'sol_adaptive', presetId = 'manga_jp') {
  const calls = [];
  const result = await runAnalysisPipeline({ mode, presetId,
    primary: async (stage) => { calls.push(stage); return draft; },
    verify: async (stage) => { calls.push(stage); return final; },
  });
  return { result, calls };
}

test('adaptive uses exactly Sol low once on a valid clear page', async () => {
  const { result, calls } = await run(page());
  assert.deepEqual(calls, [{ model: 'gpt-6.1-sol', effort: 'low' }]);
  assert.equal(result.automation.analysisPassCount, 1);
  assert.equal(result.automation.fallbackTriggered, false);
});
test('item uncertainty triggers exactly one Sol high call with draft', async () => {
  const draft = page([item({ source_confidence: 'low', needs_review: true, review_reason: '二/三 판독 불확실' })]);
  const { result, calls } = await run(draft);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, 'gpt-6.1-sol');
  assert.equal(calls[1].effort, 'high');
  assert.equal(calls[1].draft, draft);
  assert.equal(result.automation.fallbackTriggered, true);
  assert.equal(result.automation.verificationModel, 'gpt-6.1-sol');
  assert.equal(result.automation.unresolvedItemCount, 0);
});
test('coverage uncertainty triggers high even with confident items', async () => {
  const { calls } = await run(page([item()], { coverage_confidence: 'low' }));
  assert.equal(calls.length, 2);
});
test('a low pass with missing items can recover added occurrences', async () => {
  const { result, calls } = await run(page([]), page([item(), item({ source_text: '猫', translated_text: '고양이' })]));
  assert.equal(calls.length, 2);
  assert.equal(result.reading_order.length, 2);
});
test('code catches blank translation even when the model reports confidence', async () => {
  const { calls } = await run(page([item({ translated_text: '' })]));
  assert.equal(calls.length, 2);
});
test('Latin mismatches trigger verification and cannot pass final validation', async () => {
  const bad = page([item({ source_text: 'Axe（斧）', translated_text: '액스(도끼)' })]);
  const { result } = await run(bad, page([item({ source_text: 'Axe（斧）', translated_text: 'Axe（도끼）' })]));
  assert.equal(result.automation.fallbackTriggered, true);
  await assert.rejects(run(bad, bad), /영문 원문 보존/);
  await assert.rejects(run(bad, bad, 'sol_double'), /영문 원문 보존/);
});
test('high unresolved result is visible but never causes a third call', async () => {
  const uncertain = page([item({ translation_confidence: 'medium', review_reason: '화자 불명확', needs_review: true })]);
  const { calls, result } = await run(uncertain, uncertain);
  assert.equal(calls.length, 2);
  assert.equal(result.automation.pageNeedsReview, true);
  assert.equal(result.automation.unresolvedItemCount, 1);
  assert.ok(result.reading_order[0].review_reasons.includes('화자 불명확'));
});
test('incomplete final result blocks generation in every mode', async () => {
  for (const mode of ['sol_adaptive', 'sol_double']) {
    await assert.rejects(run(page([item({ translated_text: '' })]), page([]), mode), /불완전/);
  }
});
test('legacy mode mapping is preserved and new users default adaptive', () => {
  assert.equal(normalizeAnalysisMode(), 'sol_adaptive');
  assert.equal(normalizeAnalysisMode(undefined, true), 'sol_double');
  assert.equal(normalizeAnalysisMode(undefined, 'false'), 'sol_adaptive');
  assert.equal(normalizeAnalysisMode('terra_single'), 'sol_adaptive');
  assert.equal(normalizeAnalysisMode('sol_adaptive', true), 'sol_adaptive');
});
test('legacy full verification always uses high twice; removed Terra mode uses adaptive Sol', async () => {
  assert.deepEqual((await run(page(), page(), 'sol_double')).calls.map(c => c.effort), ['high', 'high']);
  assert.deepEqual((await run(page(), page(), 'terra_single')).calls, [{ model: 'gpt-6.1-sol', effort: 'low' }]);
});
test('documents get conditional high; legacy high documents remain one pass', async () => {
  const good = { blocks: [{ text: '문서 번역' }], audit: page().audit };
  const bad = { ...good, audit: { ...good.audit, needs_review: true, review_reason: '수량 확인 필요' } };
  assert.equal((await run(bad, good, 'sol_adaptive', 'document')).calls.length, 2);
  assert.equal((await run(good, good, 'sol_double', 'document')).calls.length, 1);
});
test('one insertion is one change; single numeral changes are counted', () => {
  const a = item(), b = item({ source_text: '別の文章', translated_text: '다른 문장' });
  assert.equal(countChangedOccurrences([a,b], [item({ source_text: 'new' }),a,b]), 1);
  assert.equal(countChangedOccurrences([item({ source_text: 'There are 10 people here' })], [item({ source_text: 'There are 20 people here' })]), 1);
});
test('network error never triggers an expensive quality escalation', async () => {
  let verified = false;
  await assert.rejects(runAnalysisPipeline({ mode: 'sol_adaptive', presetId: 'comic', primary: async () => { throw new Error('network failed'); }, verify: async () => { verified = true; } }), /network/);
  assert.equal(verified, false);
});
test('SSE handles split UTF-8, CRLF, no-space data, and final unterminated event', async () => {
  const bytes = new TextEncoder().encode('data:' + JSON.stringify({type:'response.output_text.done',text:'한글'}) + '\r\n\r\n' + 'data: {"type":"response.completed"}');
  const response = new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }));
  const events = [];
  for await (const event of responseEvents(response)) events.push(event);
  assert.equal(events[0].text, '한글');
  assert.equal(events[1].type, 'response.completed');
});
