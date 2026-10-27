// Native protocol regression tests: routing, account isolation, tool denial.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'claudely-providers-'));
const fixture = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const provider=path.basename(process.argv[1]);const args=process.argv.slice(2);
if(args[0]==='auth'||(provider==='codex'&&args[0]==='login')){
 console.log(provider==='claude'?JSON.stringify({loggedIn:true}):provider==='codex'?'Logged in using ChatGPT':'OpenAI OAuth stored');process.exit(0);
}
if(args[0]==='models'){console.log('openai/test-model');process.exit(0)}
if(args[0]==='debug'){console.log(JSON.stringify({models:[{slug:'test-model'}]}));process.exit(0)}
if(args.includes('error-model')){console.log(JSON.stringify({type:'error',error:{message:'Request failed: 401'}}));process.exit(1)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const env=Object.fromEntries(['CODEX_HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_BASE_URL','T3_PROXY_API_KEY','OPENCODE_CONFIG_CONTENT'].map(k=>[k,process.env[k]??null]));
const result={text:'Corrected.',provider,args,env,input};
if(provider==='codex')fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(result));
else if(provider==='claude')console.log(JSON.stringify({structured_output:result}));
else console.log(JSON.stringify({type:'text',part:{text:JSON.stringify(result)}}));
});`;
for (const provider of ['claude', 'codex', 'opencode']) await writeFile(path.join(directory, provider), fixture, { mode: 0o700 });
const host = spawn(process.execPath, [new URL('../host/claudely-host.mjs', import.meta.url).pathname], {
  env: { ...process.env, CODEX_HOME: '/unrelated-parent', CLAUDE_CONFIG_DIR: '/unrelated-parent',
    ANTHROPIC_BASE_URL: 'https://unrelated.invalid', T3_PROXY_API_KEY: 'parent-value',
    ...Object.fromEntries(['claude', 'codex', 'opencode'].map((p) => [`CLAUDELY_${p.toUpperCase()}_BIN`, path.join(directory, p)])),
  }, stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = Buffer.alloc(0);
let nextId = 0;
const pending = new Map();
host.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const size = buffer.readUInt32LE(0);
    const response = JSON.parse(buffer.subarray(4, 4 + size));
    buffer = buffer.subarray(4 + size);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});
function call(message) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const body = Buffer.from(JSON.stringify({ ...message, id }));
    const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([size, body]));
  });
}
after(async () => { host.stdin.end(); await rm(directory, { recursive: true, force: true }); });

test('all local accounts and model catalogs are exposed without credentials', { timeout: 10000 }, async () => {
  const status = await call({ type: 'ping' });
  for (const p of ['claude', 'codex', 'opencode']) {
    assert.equal(status.result.providers[p].authenticated, true);
    const models = await call({ type: 'models', provider: p, connection: 'local' });
    assert.ok(models.result.models.length);
  }
  assert.ok(!JSON.stringify(status).includes('parent-value'));
});

for (const provider of ['claude', 'codex', 'opencode']) test(`${provider}: selected model and isolated text-only execution`, { timeout: 10000 }, async () => {
  const response = await call({ type: 'run', provider, connection: 'local', model: 'test-model', prompt: 'Untrusted text', schema: { type: 'object' } });
  assert.equal(response.ok, true, response.error);
  const result = response.result;
  assert.equal(result.provider, provider);
  assert.ok(result.args.includes('test-model'));
  assert.ok(result.input.includes('Untrusted text'));
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'T3_PROXY_API_KEY']) assert.equal(result.env[key], null);
  if (provider === 'claude') assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  if (provider === 'codex') { assert.ok(result.args.includes('read-only')); assert.ok(result.args.includes('shell_tool')); }
  if (provider === 'opencode') {
    assert.ok(result.args.includes('--standalone'));
    assert.ok(result.args.includes('claudely'));
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.agents.claudely.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  }
});

test('OpenCode upstream failures reach the UI; unknown providers fail closed', { timeout: 10000 }, async () => {
  const response = await call({ type: 'run', provider: 'opencode', connection: 'local', model: 'error-model' });
  assert.equal(response.ok, false);
  assert.equal(response.error, 'Request failed: 401');
  assert.equal((await call({ type: 'run', provider: 'unknown' })).ok, false);
});
