// Minimal Chrome DevTools Protocol driver for manual testing.
// Usage: node tools/cdp.mjs <command> [args]   (browser on CDP_PORT, default 9333)
//   nav <url> | eval <js> | xeval <js> | shot <file> | click <x> <y> | move <x> <y> | type <text> | key <Key> | sleep <ms>
// xeval runs in Claudely's content-script world (every frame); __claudelyDebug is defined there.
// Several commands can be chained with "--":  nav URL -- sleep 500 -- shot a.png
const port = process.env.CDP_PORT || 9333;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter((t) => t.type === (process.env.CDP_TYPE || 'page') && t.url.startsWith(process.env.CDP_MATCH || 'http'));
const page = pages.find((t) => t.title) || pages[0] || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let nextId = 1;
const waiting = new Map();
const worlds = new Map(); // contextId -> frameId, for Claudely's isolated worlds
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.executionContextCreated') {
    const c = msg.params.context;
    if (c.name === 'Claudely') worlds.set(c.id, c.auxData?.frameId);
  }
  if (msg.method === 'Runtime.executionContextDestroyed') worlds.delete(msg.params.executionContextId);
  if (msg.method === 'Runtime.executionContextsCleared') worlds.clear();
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
});
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    });
  });
}

if (page.type === 'page') {
  await cdp('Page.bringToFront');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x: +x, y: +y, button: 'left', clickCount: 1, ...extra });

const commands = {
  async nav(url) {
    await cdp('Page.enable');
    await cdp('Page.navigate', { url });
    await sleep(1200);
  },
  async eval(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    console.log(r.exceptionDetails ? `ERROR ${r.exceptionDetails.exception?.description}` : JSON.stringify(r.result.value, null, 2));
  },
  // Runs in every frame's Claudely world and prints results from frames where
  // the expression isn't null/undefined.
  async xeval(expr) {
    await cdp('Runtime.enable');
    await sleep(150);
    const out = [];
    for (const contextId of worlds.keys()) {
      try {
        const r = await cdp('Runtime.evaluate', { expression: expr, contextId, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) out.push(`ERROR ${r.exceptionDetails.exception?.description}`);
        else if (r.result.value != null) out.push(r.result.value);
      } catch {}
    }
    console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
  },
  async shot(file) {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', file);
  },
  async click(x, y) {
    await mouse('mouseMoved', x, y, { button: 'none' });
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
  },
  async move(x, y) {
    await mouse('mouseMoved', x, y, { button: 'none' });
  },
  async type(text) {
    for (const ch of text) {
      await cdp('Input.insertText', { text: ch });
      await sleep(25);
    }
  },
  async key(key) {
    const mods = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
    const parts = key.split('+');
    const k = parts.pop();
    const modifiers = parts.reduce((m, p) => m | mods[p], 0);
    const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
    const base = { key: k, code, modifiers, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, Backspace: 8 }[k] };
    // Enter needs its text so editors get a beforeinput insertParagraph.
    if (k === 'Enter' && !modifiers) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base });
    else await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  },
  async sleep(ms) {
    await sleep(+ms);
  },
};

const argv = process.argv.slice(2);
const groups = [[]];
for (const a of argv) a === '--' ? groups.push([]) : groups.at(-1).push(a);
for (const [cmd, ...args] of groups) {
  if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
  await commands[cmd](...args);
}
ws.close();
