import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createOpenAIOAuthFetchHandler, startOpenAIOAuthServer } from 'openai-oauth';
import { resolveInstalledCodexVersion, withCodexClientVersion, verifyOAuthModels } from '../lib/oauth-runtime.mjs';

try {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '10531' }, models: { type: 'string', default: 'gpt-6.1-sol' }, 'codex-version': { type: 'string', default: '' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OAuth port.');
  const version = await resolveInstalledCodexVersion({ override: values['codex-version'] || process.env.OAUTH_CODEX_VERSION || '' });
  const settings = { codexVersion: version, fetch: withCodexClientVersion(version) };
  console.log(`Codex client version: ${version}`);
  // No configured model list here: force a real upstream discovery request.
  const available = await verifyOAuthModels(createOpenAIOAuthFetchHandler(settings), values.models.split(',').map(x => x.trim()).filter(Boolean));
  console.log(`Verified upstream models: ${available.join(', ')}`);
  const proxy = await startOpenAIOAuthServer({ ...settings, host: '127.0.0.1', port, models: available });
  console.log(`OpenAI-compatible endpoint ready at ${proxy.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    proxy.server.closeAllConnections();
    proxy.close().finally(() => process.exit(0));
  });
} catch (error) {
  console.error(`[oauth-startup] ${error.message}`);
  process.exitCode = 1;
}
