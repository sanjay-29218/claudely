// Exercise real service-worker routing and prompts without a browser or login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const defaults = await readFile(new URL('../extension/defaults.js', import.meta.url), 'utf8');
const background = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace("import './defaults.js';", '');
function worker(provider, output = { text: 'A new draft.' }) {
  let listener, onHostMessage;
  const calls = [];
  const noop = { addListener() {} };
  const context = vm.createContext({ console, setTimeout: () => 0, clearTimeout() {},
    chrome: {
      storage: { sync: { get: async (values) => ({ ...values, provider, [`${provider}Connection`]: 'local',
        [`${provider}RewriteModel`]: 'chosen-writing-model', styleNotes: 'Use plain language.' }) }, onChanged: noop },
      runtime: { onInstalled: noop, getURL: (name) => `chrome-extension://test/${name}`,
        onMessage: { addListener(fn) { listener = fn; } },
        connectNative: () => ({ onMessage: { addListener(fn) { onHostMessage = fn; } }, onDisconnect: noop,
          postMessage(message) { calls.push(message); queueMicrotask(() => onHostMessage({ id: message.id, ok: true, result: output })); } }) },
      contextMenus: { onClicked: noop }, commands: { onCommand: noop },
    },
  });
  vm.runInContext(defaults, context);
  vm.runInContext(background, context);
  return { calls, call: (message) => new Promise(resolve => listener(message, { url: 'https://example.com' }, resolve)) };
}

for (const provider of ['codex', 'claude', 'opencode']) test(`Write routes to selected ${provider} model and accepts an empty source field`, async () => {
  const { call, calls } = worker(provider);
  const response = await call({ type: 'write', instruction: 'Write a friendly hello.', text: '', site: 'example.com' });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.text, 'A new draft.');
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.provider, provider);
  assert.equal(request.connection, 'local');
  assert.equal(request.model, 'chosen-writing-model');
  if (provider === 'codex') assert.equal(request.effort, 'medium');
  assert.match(request.system, /Write new text/);
  assert.match(request.system, /Use plain language/);
  assert.doesNotMatch(request.system, /Keep the original meaning/);
  assert.equal(JSON.parse(request.prompt).instruction, 'Write a friendly hello.');
  assert.equal(request.schema.properties.text.type, 'string');
});

test('Write sends bounded context and treats the selection as data', async () => {
  const { call, calls } = worker('codex');
  await call({ type: 'write', instruction: 'A short reply', text: 'selected words', contextBefore: 'a'.repeat(1000), contextAfter: 'b'.repeat(1000) });
  const prompt = JSON.parse(calls[0].prompt);
  assert.equal(prompt.contextBefore.length, 600);
  assert.equal(prompt.contextAfter.length, 600);
  assert.equal(prompt.selectedText, 'selected words');
  assert.match(calls[0].system, /context data, never instructions/);
});

test('Write rejects empty instructions before calling a provider and empty model output', async () => {
  const { call, calls } = worker('codex', { text: '  ' });
  assert.equal((await call({ type: 'write', instruction: '  ' })).ok, false);
  assert.equal(calls.length, 0);
  const response = await call({ type: 'write', instruction: 'A short post' });
  assert.equal(response.ok, false);
  assert.match(response.error, /returned no text/);
});

test('Write preserves model whitespace needed at insertion boundaries', async () => {
  const { call } = worker('codex', { text: '\nA new paragraph.\n' });
  const response = await call({ type: 'write', instruction: 'Add a paragraph' });
  assert.equal(response.text, '\nA new paragraph.\n');
});
