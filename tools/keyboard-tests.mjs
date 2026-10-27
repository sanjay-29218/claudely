// Offline browser regression: real key events against the actual content script.
// Needs Chrome with remote debugging on CDP_PORT (default 9333). No CLI or login.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    response.error ? entry.reject(new Error(response.error.message)) : entry.resolve(response.result);
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

let version;
for (let attempt = 0; attempt < 40; attempt++) {
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
  catch { await sleep(250); }
}
assert.ok(version, `Start Chrome with --remote-debugging-port=${port} first.`);
const browser = await connect(version.webSocketDebuggerUrl);
const { browserContextId } = await browser.call('Target.createBrowserContext');
const defaults = await readFile(new URL('../extension/defaults.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

try {
  for (const width of [1280, 390]) {
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const client = await connect(targets.find((target) => target.id === targetId).webSocketDebuggerUrl);
    async function evaluate(expression, contextId) {
      const result = await client.call('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    async function waitFor(expression, contextId) {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression, contextId)) return;
        await sleep(25);
      }
      throw new Error(`Condition timed out: ${expression}`);
    }
    async function find(selector) {
      const { root } = await client.call('DOM.getDocument', { depth: -1, pierce: true });
      const nodes = [];
      function walk(node) {
        nodes.push(node);
        for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) walk(child);
      }
      walk(root);
      return nodes.find((node) => selector(node, Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, i) => node.attributes.slice(i * 2, i * 2 + 2)))));
    }
    async function onNode(node, functionDeclaration) {
      assert.ok(node, 'Expected UI control to exist');
      const { object } = await client.call('DOM.resolveNode', { backendNodeId: node.backendNodeId });
      const result = await client.call('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function key(key, options = {}) {
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 }[key], ...options };
      await client.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key.length === 1 && !options.modifiers ? { text: key } : {}) });
      await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
    async function point(node) {
      return onNode(node, `function(){
        const r=this.getBoundingClientRect();
        const frame=this.ownerDocument.defaultView.frameElement?.getBoundingClientRect();
        return {x:r.left+r.width/2+(frame?.left||0),y:r.top+r.height/2+(frame?.top||0)};
      }`);
    }
    async function click(node) {
      const position = await point(node);
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    }
    async function assertVisible(selector) {
      const bounds = await onNode(await find((node, attrs) => attrs.class === selector), `function(){
        const r=this.getBoundingClientRect();
        const frame=this.ownerDocument.defaultView.frameElement.getBoundingClientRect();
        return {left:frame.left+r.left,right:frame.left+r.right};
      }`);
      const viewportWidth = await evaluate('document.documentElement.clientWidth');
      assert.ok(bounds.left >= 8 && bounds.right <= viewportWidth - 8,
        `${selector} must fit inside the viewport: ${JSON.stringify(bounds)} / ${viewportWidth}`);
    }
    try {
      await client.call('Page.enable');
      await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await client.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Register before the extension, including the capture phase that a
      // shadow-root stopPropagation handler cannot shield against.
      await client.call('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.hostEvents = [];
        for (const target of [window, document]) for (const capture of [true, false])
          for (const type of ['keydown','keypress','keyup','beforeinput','input','compositionstart','compositionend','copy','paste'])
            target.addEventListener(type, e => { hostEvents.push({type, key:e.key, capture}); if (e.key === 'j') scrollBy(0,100); if(e.key === 'k') scrollBy(0,-100); }, capture);
      ` });
      const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'">
        <style>body{margin:40px 20px;min-height:3000px}textarea{width:280px;height:160px}</style>
        <textarea id="editor">teh writing example</textarea><button id="pageButton">Page target</button>`;
      await client.call('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
      await waitFor('!!document.getElementById("editor")');
      const { frameTree } = await client.call('Page.getFrameTree');
      const { executionContextId } = await client.call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'Claudely keyboard tests' });
      await evaluate(`${defaults}
        globalThis.requests = [];
        globalThis.chrome = {
          storage: { sync: { get: async defaults => ({...defaults, autoCheck:false}) }, local: {get:async()=>({dictionary:[]})}, onChanged:{addListener(){}} },
          runtime: { id:'keyboard-tests', onMessage:{addListener(fn){ globalThis.command=fn; }},
            async sendMessage(msg) { requests.push(msg); return msg.type==='check'
              ? {ok:true,results:msg.paragraphs.map(()=>[{original:'teh',replacement:'the',before:'',category:'spelling',message:'Spelling'}])}
              : {ok:true,text:'The writing example.'}; }
          }
        };
        ${source}`, executionContextId);
      await evaluate('document.getElementById("editor").focus()');
      await waitFor('__claudelyDebug.state().active', executionContextId);
      await waitFor('!!document.querySelector("claudely-root")');
      await evaluate('document.getElementById("editor").setSelectionRange(4,11)');
      const badge = await find((node, attrs) => node.nodeName === 'BUTTON' && attrs.class === 'badge');
      await click(badge);
      await waitFor('__claudelyDebug.state().panel', executionContextId);
      await assertVisible('panel');
      assert.deepEqual(await evaluate('(()=>{const e=document.getElementById("editor");return [e.selectionStart,e.selectionEnd]})()'), [4, 11], 'Badge clicks must preserve the source selection');
      let input = await find((node, attrs) => attrs['aria-label'] === 'Custom rewrite instruction');
      await click(input);
      await evaluate('hostEvents.length=0');
      for (const letter of ['j', 'k', 'x']) await key(letter);
      await key('Backspace');
      assert.equal(await onNode(input, 'function(){return this.value}'), 'jk');
      assert.deepEqual(await evaluate('hostEvents'), [], 'Typing must not reach page listeners at any phase');
      assert.equal(await evaluate('scrollY'), 0, 'Page shortcuts must not scroll behind the panel');
      if (process.env.SCREENSHOT_DIR) await writeFile(path.join(process.env.SCREENSHOT_DIR, `claudely-keyboard-${width}.png`), Buffer.from((await client.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      // Preserve native selection/editing shortcuts rather than canceling them.
      await key('a', { modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
      await client.call('Input.insertText', { text: '日本語 🙂' });
      assert.equal(await onNode(input, 'function(){return this.value}'), '日本語 🙂');
      await onNode(input, `function(){
        this.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,composed:true}));
        this.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));
        this.dispatchEvent(new CompositionEvent('compositionend',{data:'日本語',bubbles:true,composed:true}));
        this.dispatchEvent(new Event('copy',{bubbles:true,composed:true}));
        this.dispatchEvent(new Event('paste',{bubbles:true,composed:true}));
      }`);
      assert.equal(await evaluate('requests.filter(r=>r.type==="rewrite").length', executionContextId), 0, 'IME Enter must not submit');
      assert.deepEqual(await evaluate('hostEvents'), [], 'Composition and clipboard events must stay inside the frame');
      await key('Enter');
      await waitFor('__claudelyDebug.state().panelView==="result"', executionContextId);
      assert.equal(await evaluate('requests.filter(r=>r.type==="rewrite").length', executionContextId), 1);
      // Buttons also own their keys; Escape releases focus only after keyup.
      const replace = await find((node, attrs) => node.nodeName === 'BUTTON' && attrs.class === 'btn primary');
      await onNode(replace, 'function(){this.focus()}');
      await key('j'); await key('k');
      assert.deepEqual(await evaluate('hostEvents'), []);
      await key('Escape');
      assert.equal(await evaluate('__claudelyDebug.state().panel', executionContextId), false);
      assert.equal(await evaluate('document.activeElement.id'), 'editor');
      assert.deepEqual(await evaluate('hostEvents'), [], 'Escape keyup must not escape when the panel closes');
      assert.equal(await evaluate('document.getElementById("editor").value'), 'teh writing example', 'Prompt input must not edit the page field');
      await evaluate('command({type:"command",command:"check-now",targeted:true})', executionContextId);
      await waitFor('__claudelyDebug.state().issues.length > 0', executionContextId);
      await sleep(50);
      const underline = await find((node, attrs) => attrs.class === 'ul');
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(underline) });
      await sleep(350);
      const fix = await find((node, attrs) => attrs.title === 'Accept suggestion');
      await assertVisible('card');
      await onNode(fix, 'function(){this.focus()}');
      await key('j'); await key('k');
      assert.deepEqual(await evaluate('hostEvents'), [], 'Suggestion card shortcuts must also stay isolated');
      await click(fix);
      await waitFor('document.getElementById("editor").value === "the writing example"');
      assert.ok((await evaluate('hostEvents')).every((event) => event.type === 'input'), 'Applying a correction must still notify the page editor');
      await evaluate('hostEvents.length=0');
      const keyboardBadge = await find((node, attrs) => node.nodeName === 'BUTTON' && /\bbadge\b/.test(attrs.class || ''));
      await onNode(keyboardBadge, 'function(){this.focus()}');
      await key('j'); await key('k');
      assert.deepEqual(await evaluate('hostEvents'), [], 'Focused badge shortcuts must stay isolated');
      await evaluate('document.getElementById("pageButton").focus()');
      await key('j');
      assert.ok((await evaluate('hostEvents')).length > 0, 'Host shortcuts must resume outside Claudely');
      console.log(`PASS ${width}px: capture/bubble isolation, native typing and mouse clicks, selection, IME, clipboard, Enter, Escape, cards, badge, focus return, strict CSP.`);
    } finally {
      client.close();
      await browser.call('Target.closeTarget', { targetId });
    }
  }
} finally {
  await browser.call('Target.disposeBrowserContext', { browserContextId });
  browser.close();
}
