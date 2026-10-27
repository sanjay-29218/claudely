// End-to-end check against real editors: types text with known mistakes,
// waits for underlines, accepts them all, and compares the editor's text.
// Needs tools/test-browser.sh running (and `python3 -m http.server 8765` in
// tools/ for the local cases). Usage: node tools/editor-tests.mjs [name...]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp.mjs');
const LINE1 = 'Me and him was planning to meet at the libary, but it begun raining alot.';
const LINE2 = 'We should of left earlier, its to late now.';
const FIXED = ['library', 'began', 'a lot', 'should have', 'too late'];
const BROKEN = ['libary', 'begun', 'alot', 'should of', ' to late'];

const cases = {
  textarea: { url: 'http://127.0.0.1:8765/playground.html', sel: '#controlled', model: "document.getElementById('mirrorOut').textContent.replace('state: ', '')" },
  contenteditable: { url: 'http://127.0.0.1:8765/playground.html', sel: '#ce' },
  lexical: { url: 'https://playground.lexical.dev/', sel: '.ContentEditable__root' },
  prosemirror: { url: 'https://prosemirror.net/examples/basic/', sel: '.ProseMirror', model: "view.state.doc.textBetween(0, view.state.doc.content.size, '\\n')" },
  slate: { url: 'https://www.slatejs.org/examples/richtext', sel: '[data-slate-editor]' },
  draft: { url: 'https://draftjs.org/', sel: '.public-DraftEditor-content' },
  // Edits inside an about:srcdoc iframe whose body has spellcheck="false".
  tinymce: { url: 'https://www.tiny.cloud/docs/tinymce/latest/basic-example/', sel: 'iframe.tox-edit-area__iframe', clear: "tinymce.activeEditor.setContent(''); tinymce.activeEditor.focus()", model: "tinymce.activeEditor.getContent({ format: 'text' })" },
  ckeditor: { url: 'https://ckeditor.com/docs/ckeditor5/latest/examples/builds/classic-editor.html', sel: '.ck-editor__editable', model: "[...new DOMParser().parseFromString(document.querySelector('.ck-editor__editable').ckeditorInstance.getData(), 'text/html').body.children].map((p) => p.textContent).join('\\n')" },
};

function cdp(...args) {
  return execFileSync('node', [CDP, ...args], { encoding: 'utf8', timeout: 120000 }).trim();
}
const json = (out) => JSON.parse(out);
// xeval returns one result per frame; use the frame with the active field.
const debugState = () => {
  const r = json(cdp('xeval', '__claudelyDebug.state()'));
  return Array.isArray(r) ? r.find((x) => x.active) || r[0] || {} : r;
};

async function run(name, c) {
  cdp('nav', c.url, '--', 'sleep', '3000');
  const center = json(cdp('eval', `(() => { const e = document.querySelector(${JSON.stringify(c.sel)}); e.scrollIntoView({ block: e.offsetHeight > innerHeight / 2 ? 'start' : 'center' }); scrollBy(0, -120); const r = e.getBoundingClientRect(); return [Math.round(r.x + Math.min(r.width / 2, 200)), Math.round(r.y + Math.min(r.height / 2, 24))]; })()`));
  cdp('click', ...center.map(String), ...(c.clear ? ['--', 'eval', c.clear] : ['--', 'eval', "document.execCommand('selectAll')", '--', 'key', 'Backspace']), '--', 'sleep', '300',
    '--', 'type', LINE1, '--', 'key', 'Enter', '--', 'type', LINE2);
  let state;
  for (let i = 0; i < 20; i++) {
    cdp('sleep', '1500');
    state = debugState();
    if (state.status === 'done' && state.issues.length) break;
  }
  if (!state.issues?.length) return `FAIL no issues (status ${state.status}, ${state.error || ''})`;
  if (state.rects.some((n) => !n)) return `FAIL some underlines have no rects ${JSON.stringify(state.rects)}`;
  const found = state.issues.length;
  cdp('xeval', '__claudelyDebug.acceptAll()', '--', 'sleep', '1000');
  const after = debugState();
  const model = c.model ? json(cdp('eval', c.model)) : after.text;
  const lines = after.text.split('\n').filter(Boolean);
  const problems = [];
  if (lines.length !== 2) problems.push(`expected 2 paragraphs, got ${lines.length}`);
  for (const w of BROKEN) if (after.text.includes(w)) problems.push(`still has "${w}"`);
  for (const w of FIXED) if (!after.text.includes(w)) problems.push(`missing "${w}"`);
  if (/\S\s{2,}\S|\w\.\w/.test(after.text)) problems.push('spacing damage');
  if (model.replace(/\s+/g, ' ').trim() !== after.text.replace(/\s+/g, ' ').trim()) problems.push(`editor model differs: ${JSON.stringify(model)}`);
  return `${problems.length ? 'FAIL' : 'ok  '} ${found} issues → ${JSON.stringify(after.text)}${problems.length ? `\n      ${problems.join('; ')}` : ''}`;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases);
for (const name of names) {
  let result;
  try {
    result = await run(name, cases[name]);
  } catch (err) {
    result = `FAIL ${err.message.split('\n')[0]}`;
  }
  console.log(`${name.padEnd(16)} ${result}`);
}
