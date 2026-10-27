#!/usr/bin/env node
// Claudely native messaging host.
//
// Chrome talks to this process over stdin/stdout using the native messaging
// framing (4-byte little-endian length + UTF-8 JSON). Each request runs the
// locally installed `claude`, `codex`, or `opencode` CLI so it bills against your existing
// subscription. The CLIs are run with tools disabled: the text being checked
// comes from arbitrary web pages and must never be able to make the model act.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, promises as fsp, constants as FS } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BINS, inspectProvider, connectionEnv, modelCatalog, launchLogin, validateProvider } from './connections.mjs';

const VERSION = '0.2.0';
const CLAUDE_BIN = BINS.claude;
const CODEX_BIN = BINS.codex;
const WORK_DIR = path.join(os.tmpdir(), 'claudely-host');
const LOG_FILE = path.join(WORK_DIR, 'host.log');
const TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 4;

// Codex features that give the model tools. Code mode fails closed when its
// host is disabled, which removes the last tool surface.
const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'memories', 'code_mode_host', 'skill_search', 'tool_suggest',
];

mkdirSync(WORK_DIR, { recursive: true });

function log(...parts) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Native messaging framing

let inbox = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4) {
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) break;
    const body = inbox.subarray(4, 4 + len).toString('utf8');
    inbox = inbox.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      log('dropping malformed message');
      continue;
    }
    handle(msg);
  }
});

process.stdin.on('end', () => {
  for (const job of jobs.values()) job.cancel();
  process.exit(0);
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ---------------------------------------------------------------------------
// Request dispatch

const jobs = new Map();
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function handle(msg) {
  const { id, type } = msg;
  try {
    if (type === 'ping') {
      send({ id, ok: true, result: await ping(msg.refresh) });
    } else if (type === 'models') {
      send({ id, ok: true, result: { models: await modelCatalog(msg.provider, msg.connection) } });
    } else if (type === 'login') {
      send({ id, ok: true, result: await launchLogin(msg.provider, msg.connection, WORK_DIR) });
    } else if (type === 'cancel') {
      jobs.get(msg.target)?.cancel();
      send({ id, ok: true });
    } else if (type === 'run') {
      validateProvider(msg.provider);
      const job = new Job(id);
      jobs.set(id, job);
      try {
        await acquire();
        try {
          if (job.cancelled) throw new Error('cancelled');
          job.connection = await connectionEnv(msg.provider, msg.connection);
          const runner = { claude: runClaude, codex: runCodex, opencode: runOpenCode }[msg.provider];
          const result = await runner(msg, job);
          send({ id, ok: true, result });
        } finally {
          release();
        }
      } finally {
        jobs.delete(id);
      }
    } else {
      throw new Error(`unknown request type: ${type}`);
    }
  } catch (err) {
    const error = String(err?.message || err);
    if (error !== 'cancelled') log(`request ${id} (${type}) failed: ${error}`);
    send({ id, ok: false, error, cancelled: error === 'cancelled' });
  }
}

class Job {
  constructor(id) {
    this.id = id;
    this.child = null;
    this.cancelled = false;
  }
  cancel() {
    this.cancelled = true;
    this.child?.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Providers

async function runClaude(msg, job) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', msg.model || 'haiku',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', msg.system || '',
  ];
  if (msg.schema) args.push('--json-schema', JSON.stringify(msg.schema));
  if (msg.effort) args.push('--effort', msg.effort);

  const { stdout } = await exec(CLAUDE_BIN, args, msg.prompt, job);
  const out = parseClaudeOutput(stdout);
  if (!out) throw new Error('Claude returned no output');
  if (out.is_error) throw new Error(out.result || out.subtype || 'Claude returned an error');
  if (!msg.schema) return out.result;
  return out.structured_output ?? parseJsonLoose(out.result);
}

function parseClaudeOutput(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

async function runCodex(msg, job) {
  const outFile = path.join(WORK_DIR, `out-${process.pid}-${msg.id}-${Date.now()}.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--color', 'never',
    '-s', 'read-only',
    '-C', WORK_DIR,
    '-m', msg.model || 'gpt-6-luna',
    '-c', `model_reasoning_effort="${msg.effort || 'low'}"`,
    '-c', 'web_search="disabled"',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-o', outFile,
  ];
  if (job.connection.mode === 'proxy') args.push(
    '-c', 'model_provider="claudely_proxy"',
    '-c', 'model_providers.claudely_proxy={name="Connected local proxy",base_url="http://127.0.0.1:8317/v1",env_key="T3_PROXY_API_KEY",wire_api="responses"}',
  );
  if (msg.schema) args.push('--output-schema', await schemaFile(msg.schema));
  args.push('-');

  // `codex exec` has no system-prompt flag, so the instructions lead the prompt.
  const input = `${msg.system || ''}\n\n${msg.prompt}`;
  try {
    await exec(CODEX_BIN, args, input, job);
    const text = (await fsp.readFile(outFile, 'utf8')).trim();
    if (!text) throw new Error('Codex returned no output');
    return msg.schema ? parseJsonLoose(text) : text;
  } finally {
    fsp.rm(outFile, { force: true }).catch(() => {});
  }
}

async function runOpenCode(msg, job) {
  // A private server avoids changing permissions on the user's running sessions.
  // Deny every tool for untrusted page text, including plugin and MCP tools.
  Object.assign(job.connection.env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      agents: { claudely: {
        description: 'Text-only writing assistant', mode: 'primary',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      } },
    }),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_PURE: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  });
  const args = ['run', '--standalone', '--format', 'json', '--agent', 'claudely', '--model', msg.model || 'openai/gpt-6-luna'];
  const schema = msg.schema ? `\nReturn only JSON matching this schema: ${JSON.stringify(msg.schema)}` : '';
  const { stdout } = await exec(BINS.opencode, args, `${msg.system || ''}${schema}\n\n${msg.prompt}`, job);
  let text = '';
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'error') throw new Error(event.error?.data?.message || event.error?.message || 'OpenCode returned an error');
    if (event.type === 'text') text += event.part?.text ?? event.text ?? '';
  }
  if (!text.trim()) throw new Error('OpenCode returned no text. Check the selected model and local account.');
  return msg.schema ? parseJsonLoose(text) : text.trim();
}

async function schemaFile(schema) {
  const json = JSON.stringify(schema);
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  const file = path.join(WORK_DIR, `schema-${hash}.json`);
  try {
    await fsp.access(file);
  } catch {
    await fsp.writeFile(file, json);
  }
  return file;
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('Model did not return JSON');
}

// ---------------------------------------------------------------------------
// Process helpers

function exec(bin, args, input, job) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('cancelled'));
    const child = spawn(bin, args, { cwd: WORK_DIR, env: { ...job.connection.env, PWD: WORK_DIR }, stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${path.basename(bin)} CLI not found (${bin}). Re-run host/install.sh.`) : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      job.child = null;
      if (job.cancelled) return reject(new Error('cancelled'));
      if (code === 0) return resolve({ stdout, stderr });
      if (signal) return reject(new Error(`${path.basename(bin)} timed out`));
      reject(new Error(describeFailure(stdout, stderr, code)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function describeFailure(stdout, stderr, code) {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'error') return event.error?.data?.message || event.error?.message || 'OpenCode returned an error';
    } catch {}
  }
  const claude = parseClaudeOutput(stdout);
  if (claude?.result) return String(claude.result);
  const apiMessage = stderr.match(/"message"\s*:\s*"([^"]+)"/);
  if (apiMessage) return apiMessage[1];
  const lastLine = stderr.trim().split('\n').filter(Boolean).pop();
  return lastLine || `exited with code ${code}`;
}

async function resolveBin(bin) {
  const candidates = bin.includes('/')
    ? [bin]
    : (process.env.PATH || '').split(':').filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, FS.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function ping(refresh = false) {
  const providers = await Promise.all(Object.keys(BINS).map(async (p) => [p, {
    ...await inspectProvider(p, refresh), path: await resolveBin(BINS[p]),
  }]));
  return {
    version: VERSION,
    node: process.version,
    providers: Object.fromEntries(providers),
  };
}
