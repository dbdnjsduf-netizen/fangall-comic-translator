import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAIOAuthFetchHandler } from 'openai-oauth';
import { resolveInstalledCodexVersion, withCodexClientVersion, verifyOAuthModels } from '../lib/oauth-runtime.mjs';

test('Windows npm CLI detection uses the command shim and preserves prerelease versions', async () => {
  const version = await resolveInstalledCodexVersion({ platform: 'win32', env: { ComSpec: 'cmd.exe' }, run: async (file, args, options) => {
    assert.equal(file, 'cmd.exe');
    assert.deepEqual(args, ['/d', '/s', '/c', 'codex --version']);
    assert.equal(options.windowsHide, true);
    return { stdout: 'codex-cli 0.158.0-alpha.2.1\r\n' };
  } });
  assert.equal(version, '0.158.0-alpha.2.1');
});

test('missing CLI fails visibly instead of silently reporting a legacy version', async () => {
  await assert.rejects(resolveInstalledCodexVersion({ run: async () => { throw new Error('ENOENT'); } }), /Cannot detect/);
  await assert.rejects(resolveInstalledCodexVersion({ override: 'latest' }), /must be a Codex CLI version/);
  assert.equal(await resolveInstalledCodexVersion({ override: '0.157.1', run: async () => { throw new Error('must not run'); } }), '0.157.1');
});

test('installed OAuth package sends the detected version with a configured model list and preserves image/schema fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'translator-oauth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFilePath = join(dir, 'auth.json');
  await writeFile(authFilePath, JSON.stringify({ tokens: { access_token: 'FAKE_TEST_TOKEN', account_id: 'FAKE_TEST_ACCOUNT' } }));
  const calls = [];
  const fetch = withCodexClientVersion('0.157.1', async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined });
    if (new URL(url).pathname.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6-sol' }] });
    return new Response('data: {"type":"response.completed","response":{"id":"test","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const settings = { authFilePath, ensureFresh: false, codexVersion: '0.157.1', fetch };
  const available = await verifyOAuthModels(createOpenAIOAuthFetchHandler(settings), ['gpt-6-sol']);
  assert.deepEqual(available, ['gpt-6-sol']);
  assert.match(calls[0].url, /client_version=0\.157\.1/);
  assert.equal(calls[0].headers.get('version'), '0.157.1');
  const handler = createOpenAIOAuthFetchHandler({ ...settings, models: available });
  const body = { model: 'gpt-6-sol', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,FAKE' }] }], text: { format: { type: 'json_schema', name: 'ocr', schema: { type: 'object' } } }, tools: [{ type: 'image_generation', model: 'gpt-image-2.5-sunburst' }], stream: true };
  const response = await handler(new Request('http://127.0.0.1/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls[1].headers.get('version'), '0.157.1');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer FAKE_TEST_TOKEN');
  assert.equal(calls[1].body.model, body.model);
  assert.deepEqual(calls[1].body.tools, body.tools);
  assert.deepEqual(calls[1].body.text, body.text);
  assert.deepEqual(calls[1].body.input, body.input);
});

test('model verification rejects unavailable models and upstream errors', async () => {
  await assert.rejects(verifyOAuthModels(async () => Response.json({ data: [{ id: 'gpt-5.6-sol' }] }), ['gpt-6-sol']), /does not list.*gpt-6-sol/);
  await assert.rejects(verifyOAuthModels(async () => Response.json({ error: { message: 'Expired login' } }, { status: 401 })), /Expired login/);
});

test('version wrapper leaves authentication endpoints unchanged', async () => {
  const init = { headers: { 'content-type': 'application/json' }, body: 'test' };
  await withCodexClientVersion('0.157.1', async (_url, actual) => { assert.equal(actual, init); return Response.json({}); })('https://auth.openai.com/oauth/token', init);
});
