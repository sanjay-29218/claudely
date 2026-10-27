// Account credentials stay in the native host, never in extension storage.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runFile = promisify(execFile);
export const BINS = {
  claude: process.env.CLAUDELY_CLAUDE_BIN || 'claude',
  codex: process.env.CLAUDELY_CODEX_BIN || 'codex',
  opencode: process.env.CLAUDELY_OPENCODE_BIN || 'opencode',
};
export const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const PROXY_URL = 'http://127.0.0.1:8317';
const cache = new Map();

export function validateProvider(provider) {
  if (!Object.hasOwn(BINS, provider)) throw new Error('Choose Claude Code, Codex, or OpenCode.');
}

export function localEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  // Browser hosts must use their own selected account, not the parent agent's.
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'T3_PROXY_API_KEY']) delete env[name];
  return env;
}

async function capture(provider, args) {
  return runFile(BINS[provider], args, { env: localEnv(), timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
}

async function proxyKey() {
  try {
    const keys = JSON.parse(await fs.readFile(path.join(os.homedir(), '.config/t3-local-proxy/keys.json'), 'utf8'));
    return typeof keys.local === 'string' ? keys.local : null;
  } catch { return null; }
}

export async function inspectProvider(provider, refresh = false) {
  validateProvider(provider);
  const cached = cache.get(provider);
  if (!refresh && cached && Date.now() - cached.time < 15000) return cached.value;
  let installed = false;
  let authenticated = false;
  let account = 'Not signed in';
  try {
    const args = provider === 'codex' ? ['login', 'status'] : ['auth', provider === 'claude' ? 'status' : 'list'];
    const { stdout, stderr } = await capture(provider, args);
    installed = true;
    if (provider === 'claude') {
      const auth = JSON.parse(stdout);
      authenticated = auth.loggedIn === true;
      account = authenticated ? `Local login${auth.subscriptionType ? ` · ${auth.subscriptionType}` : ''}` : account;
    } else if (provider === 'codex') {
      authenticated = /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr);
      account = authenticated ? 'Local login' : account;
    } else {
      authenticated = /\bstored\b|[1-9]\d* credentials?|[│┃].*(?:oauth|api key)/i.test(stdout);
      account = authenticated ? 'Saved local accounts' : account;
    }
  } catch (err) {
    installed = err.code !== 'ENOENT';
    if (installed && err.killed) account = 'Login status unavailable · try Refresh';
  }
  const proxyAvailable = provider !== 'opencode' && Boolean(await proxyKey());
  const value = { available: installed, authenticated, account, proxyAvailable };
  cache.set(provider, { time: Date.now(), value });
  return value;
}

export async function resolveConnection(provider, connection = 'auto') {
  validateProvider(provider);
  if (!['auto', 'local', 'proxy'].includes(connection)) throw new Error('Unknown account connection.');
  const info = await inspectProvider(provider);
  if (!info.available) throw new Error(`${NAMES[provider]} CLI not found. Install it, then run host/install.sh.`);
  const mode = connection === 'auto' ? (info.authenticated ? 'local' : info.proxyAvailable ? 'proxy' : 'local') : connection;
  if (mode === 'proxy' && !info.proxyAvailable) throw new Error('No connected local proxy found. Choose Local CLI login and sign in.');
  return mode;
}

export async function connectionEnv(provider, connection) {
  const mode = await resolveConnection(provider, connection);
  const env = localEnv();
  if (mode === 'proxy') {
    const key = await proxyKey();
    if (provider === 'claude') {
      env.ANTHROPIC_BASE_URL = PROXY_URL;
      env.ANTHROPIC_AUTH_TOKEN = key;
      delete env.ANTHROPIC_API_KEY;
    } else env.T3_PROXY_API_KEY = key;
  }
  return { mode, env };
}

export async function modelCatalog(provider, connection) {
  const mode = await resolveConnection(provider, connection);
  if (mode === 'proxy') {
    const res = await fetch(`${PROXY_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${await proxyKey()}` }, signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Local proxy returned HTTP ${res.status}. Check that CLIProxyAPI is running.`);
    const { data = [] } = await res.json();
    return data.map((m) => m.id).filter((id) => provider === 'claude' ? /^claude-/.test(id) : /^(gpt-|o[134])/.test(id));
  }
  if (provider === 'claude') return ['haiku', 'sonnet', 'opus'];
  if (provider === 'codex') {
    const { stdout } = await capture(provider, ['debug', 'models', '--bundled']);
    const out = JSON.parse(stdout);
    return (Array.isArray(out) ? out : out.models || []).map((m) => m.slug || m.id).filter(Boolean);
  }
  const { stdout } = await capture(provider, ['models']);
  return stdout.split('\n').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w./#:-]+$/.test(s) && !/image|embedding|realtime/.test(s));
}

const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export async function launchLogin(provider, connection, directory) {
  validateProvider(provider);
  const info = await inspectProvider(provider);
  if (!info.available) throw new Error(`Install ${NAMES[provider]}, then run host/install.sh.`);
  // Login is always an explicit action. Auto uses the native CLI's login flow.
  const proxy = connection === 'proxy' && provider !== 'opencode';
  const bin = proxy ? 'cliproxyapi' : BINS[provider];
  const args = proxy ? [`--${provider}-login`] : provider === 'codex' ? ['login'] : ['auth', 'login'];
  const command = [bin, ...args].map(shellQuote).join(' ');
  if (process.platform !== 'darwin') return { launched: false, command, message: 'Run this command in your terminal, then press Refresh.' };
  const file = path.join(directory, `login-${provider}.command`);
  // Only fixed commands and host-owned paths enter the script; no page text.
  await fs.writeFile(file, `#!/bin/sh\nunset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CODEX_HOME CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN T3_PROXY_API_KEY\nexport PATH=${shellQuote(process.env.PATH || '')}\n${command}\n`, { mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', 'Terminal', file], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Could not open Terminal.')));
  });
  cache.delete(provider);
  return { launched: true, message: 'Finish signing in in Terminal or your browser, then press Refresh.' };
}
