import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function resolveInstalledCodexVersion({
  override = '', platform = process.platform, env = process.env, run = runFile,
} = {}) {
  if (override.trim()) {
    if (!versionPattern.test(override.trim())) throw new Error('OAUTH_CODEX_VERSION must be a Codex CLI version such as 0.157.1.');
    return override.trim();
  }
  try {
    // Windows installs the npm CLI as codex.cmd; execFile("codex") cannot run it.
    const result = platform === 'win32'
      ? await run(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex --version'], { windowsHide: true, timeout: 15000, env })
      : await run('codex', ['--version'], { timeout: 15000, env });
    const version = `${result.stdout || ''}\n${result.stderr || ''}`.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
    if (version) return version;
  } catch (cause) {
    throw new Error('Cannot detect the installed Codex CLI. Check codex --version or set OAUTH_CODEX_VERSION to your installed version.', { cause });
  }
  throw new Error('Codex CLI returned no recognizable version. Check codex --version.');
}

export function withCodexClientVersion(version, fetchImpl = globalThis.fetch) {
  if (!versionPattern.test(version)) throw new Error('Invalid Codex CLI version.');
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/codex/')) {
      return fetchImpl(input, init);
    }
    // Apply after the OAuth package's legacy 0.144.0 header is assembled.
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('version', version);
    const signal = init.signal ?? (url.pathname.endsWith('/models') ? AbortSignal.timeout(40000) : undefined);
    return fetchImpl(input, { ...init, headers, signal });
  };
}

export async function verifyOAuthModels(handler, requiredModels = []) {
  const response = await handler(new Request('http://127.0.0.1/v1/models'));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.detail || `Codex model lookup failed (${response.status}).`);
  const available = [...new Set((data.data || []).map(x => x.id).filter(x => typeof x === 'string' && x))];
  if (!available.length) throw new Error('Codex returned an empty model list.');
  const missing = requiredModels.filter(model => !available.includes(model));
  if (missing.length) throw new Error(`This Codex login does not list the required model(s): ${missing.join(', ')}. Check the CLI login account/workspace and client version. Available: ${available.join(', ')}`);
  return available;
}
