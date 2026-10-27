// Drives the native host over its stdio protocol, like the browser would.
// Usage: node tools/host-smoke.mjs [claude|codex|opencode] [auto|local|proxy]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const provider = process.argv[2] || 'claude';
const connection = process.argv[3] || 'auto';
const model = process.argv[4] || (provider === 'codex' ? 'gpt-6-luna' : provider === 'opencode' ? 'openai/gpt-6-luna' : 'haiku');
const hostPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../host/claudely-host.mjs');
const host = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let buf = Buffer.alloc(0);
host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    pending.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function call(msg) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ ...msg, id }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  host.stdin.write(Buffer.concat([header, body]));
  return new Promise((resolve) => pending.set(id, resolve));
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

console.log('ping:', JSON.stringify(await call({ type: 'ping' })));

let t = Date.now();
const run = await call({
  type: 'run',
  provider,
  connection,
  model,
  system: 'Fix spelling and grammar. Return only the corrected text in `text`.',
  prompt: 'their going too the park tomorow',
  schema,
});
console.log(`run (${Date.now() - t}ms):`, JSON.stringify(run));

t = Date.now();
const slow = call({ type: 'run', provider, connection, model, system: 'Write a long essay.', prompt: 'About rivers.' });
setTimeout(() => call({ type: 'cancel', target: 3 }), 300);
const cancelled = await slow;
console.log(`cancel (${Date.now() - t}ms):`, JSON.stringify(cancelled));

host.stdin.end();
if (!run.ok || !cancelled.cancelled) process.exitCode = 1;
