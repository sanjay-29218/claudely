// Claudely content script: finds the field you're writing in, proofreads it
// paragraph by paragraph through the service worker, draws underlines, and
// hosts the suggestion card, badge and rewrite panel in a shadow root.
(() => {
  // Our UI frames inherit the page origin, but are not page editors.
  if (window.frameElement?.hasAttribute('data-claudely-ui')) return;
  // A copy injected before the extension was reloaded or updated may still be
  // running in this page (in its own isolated world, so only the DOM is
  // shared). Tell it to shut down before this copy starts listening.
  document.dispatchEvent(new CustomEvent('claudely:replaced'));

  const DEFAULTS = globalThis.CLAUDELY_DEFAULTS;
  const REWRITES = globalThis.CLAUDELY_REWRITES;
  const SITE = location.hostname || 'a local page';
  const CHECK_CHAR_BUDGET = 6000;
  const MAX_PARAGRAPH_CHARS = 8000;
  const CORRECTNESS = new Set(['spelling', 'grammar', 'punctuation']);
  const CATEGORY_LABEL = {
    spelling: 'Spelling',
    grammar: 'Grammar',
    punctuation: 'Punctuation',
    clarity: 'Clarity',
    style: 'Style',
  };

  let settings = { ...DEFAULTS };
  let dictionary = new Set();
  let alive = true;
  // Every page listener is registered with this signal so teardown detaches them.
  const pageListeners = new AbortController();
  const { signal } = pageListeners;

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = s;
    refreshActive();
  });
  chrome.storage.local.get('dictionary').then(({ dictionary: words = [] }) => {
    dictionary = new Set(words.map((w) => w.toLowerCase()));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue ?? DEFAULTS[key];
      refreshActive({ resetResults: Object.keys(changes).some((key) =>
        ['provider', 'clarity', 'dialect'].includes(key) || /(?:CheckModel|CheckEffort|Connection)$/.test(key)) });
    }
    if (area === 'local' && changes.dictionary) {
      dictionary = new Set((changes.dictionary.newValue || []).map((w) => w.toLowerCase()));
      scheduleRender();
    }
  });

  function siteEnabled() {
    if (!settings.enabled) return false;
    return !settings.disabledSites.some((d) => SITE === d || SITE.endsWith(`.${d}`));
  }

  async function send(message) {
    if (!alive) return { ok: false, error: 'Extension was reloaded. Refresh this page.' };
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (/context invalidated/i.test(err?.message)) teardown();
      return { ok: false, error: 'Extension was reloaded. Refresh this page.' };
    }
  }

  // -------------------------------------------------------------------------
  // Text helpers

  function splitParagraphs(text) {
    const out = [];
    let start = 0;
    for (const line of text.split('\n')) {
      if (line.trim()) out.push({ start, text: line });
      start += line.length + 1;
    }
    return out;
  }

  function isCheckable(text) {
    if (text.length > MAX_PARAGRAPH_CHARS) return false;
    const words = text.match(/\p{L}{2,}/gu);
    return Boolean(words && words.length >= 2);
  }

  // Curly quotes and NBSPs map 1:1 to plain ones so indices are unchanged.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const APPLY_FAILED = 'Couldn’t apply that here — the text may have changed';

  function normalizeQuotes(s) {
    return s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/ /g, ' ');
  }

  const isWordChar = (c) => Boolean(c) && /[\p{L}\p{N}_]/u.test(c);

  function findSpan(para, original, before, taken) {
    const hay = normalizeQuotes(para);
    const needle = normalizeQuotes(original);
    const candidates = [];
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      if (taken.some((t) => i < t.end && end > t.start)) continue;
      // Never underline part of a word ("i" inside "is").
      if (isWordChar(needle[0]) && isWordChar(hay[i - 1])) continue;
      if (isWordChar(needle[needle.length - 1]) && isWordChar(hay[end])) continue;
      candidates.push(i);
    }
    if (!candidates.length) return -1;
    const b = normalizeQuotes(before || '').trim();
    if (b) {
      const hit = candidates.find((i) => hay.slice(0, i).trimEnd().endsWith(b));
      if (hit !== undefined) return hit;
    } else {
      const hit = candidates.find((i) => !hay.slice(0, i).trim());
      if (hit !== undefined) return hit;
    }
    return candidates[0];
  }

  function locateIssues(para, raw) {
    const out = [];
    for (const r of raw || []) {
      const start = findSpan(para, r.original, r.before, out);
      if (start < 0) continue;
      out.push({
        start,
        end: start + r.original.length,
        original: para.slice(start, start + r.original.length),
        replacement: r.replacement,
        category: CATEGORY_LABEL[r.category] ? r.category : 'grammar',
        message: r.message,
      });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // -------------------------------------------------------------------------
  // Field adapters: one for textarea/input, one for contenteditable.

  const MIRROR_PROPS = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
    'fontFeatureSettings', 'fontKerning', 'fontVariationSettings', 'lineHeight', 'letterSpacing',
    'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction',
    'whiteSpace', 'wordBreak', 'overflowWrap', 'textRendering', 'hyphens',
  ];

  class PlainAdapter {
    constructor(el) {
      this.el = el;
      this.isInput = el instanceof HTMLInputElement;
    }
    text() {
      return this.el.value;
    }
    invalidate() {}
    selection() {
      return [this.el.selectionStart ?? 0, this.el.selectionEnd ?? 0];
    }
    rectsFor(issues) {
      const el = this.el;
      const cs = getComputedStyle(el);
      const m = ui.mirror;
      for (const prop of MIRROR_PROPS) m.style[prop] = cs[prop];
      const r = el.getBoundingClientRect();
      const borderX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - borderX);
      Object.assign(m.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        boxSizing: 'border-box',
        paddingRight: `${parseFloat(cs.paddingRight) + scrollbar}px`,
        borderColor: 'transparent',
      });
      if (this.isInput) {
        const contentHeight = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        Object.assign(m.style, { whiteSpace: 'pre', overflowWrap: 'normal', lineHeight: `${contentHeight}px` });
      } else if (cs.whiteSpace === 'normal') {
        m.style.whiteSpace = 'pre-wrap';
      }

      const text = el.value;
      const frag = document.createDocumentFragment();
      const spans = [];
      let pos = 0;
      for (const issue of issues) {
        if (issue.start < pos) continue;
        frag.append(text.slice(pos, issue.start));
        const span = document.createElement('span');
        span.textContent = text.slice(issue.start, issue.end);
        frag.append(span);
        spans.push([issue, span]);
        pos = issue.end;
      }
      frag.append(`${text.slice(pos)}​`);
      m.replaceChildren(frag);
      m.scrollTop = el.scrollTop;
      m.scrollLeft = el.scrollLeft;
      const out = spans.map(([issue, span]) => ({ issue, rects: [...span.getClientRects()] }));
      m.replaceChildren();
      return out;
    }
    async replace(start, end, replacement, valid = () => true) {
      const el = this.el;
      const before = el.value;
      el.focus({ preventScroll: true });
      el.setSelectionRange(start, end);
      if (!valid()) return false;
      let ok = false;
      try {
        ok = replacement ? document.execCommand('insertText', false, replacement) : document.execCommand('delete');
      } catch {}
      if (!ok || el.value === before) {
        el.setRangeText(replacement, start, end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
  }

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
    'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL', 'TD', 'TH',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME']);

  class RichAdapter {
    constructor(root) {
      this.root = root;
      this.model = null;
    }
    invalidate() {
      this.model = null;
    }
    build() {
      if (this.model) return this.model;
      const segs = [];
      const index = new Map();
      const preCache = new Map();
      let text = '';
      const isPre = (el) => {
        let v = preCache.get(el);
        if (v === undefined) {
          v = /^pre|break-spaces/.test(getComputedStyle(el).whiteSpace);
          preCache.set(el, v);
        }
        return v;
      };
      const lineBreak = () => {
        if (text && !text.endsWith('\n')) text += '\n';
      };
      const walk = (node) => {
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === Node.TEXT_NODE) {
            let d = c.data;
            if (!d) continue;
            if (!isPre(c.parentElement)) d = d.replace(/[\n\r\t]/g, ' ');
            d = d.replace(/ /g, ' ');
            const seg = { node: c, start: text.length, end: text.length + d.length };
            segs.push(seg);
            index.set(c, seg);
            text += d;
          } else if (c.nodeType === Node.ELEMENT_NODE) {
            const tag = c.tagName.toUpperCase();
            if (tag === 'BR') {
              text += '\n';
              continue;
            }
            if (SKIP_TAGS.has(tag) || c === ui.host) continue;
            if (c.getAttribute('contenteditable') === 'false' || c.hidden) {
              text += ' ';
              continue;
            }
            const block = BLOCK_TAGS.has(tag);
            if (block) lineBreak();
            walk(c);
            if (block) lineBreak();
          }
        }
      };
      walk(this.root);
      if (text.endsWith('\n')) text = text.slice(0, -1);
      this.model = { text, segs, index };
      return this.model;
    }
    text() {
      return this.build().text;
    }
    pointAt(offset, isEnd) {
      const { segs } = this.build();
      if (!segs.length) return { node: this.root, offset: 0 };
      let lo = 0;
      let hi = segs.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].end < offset) lo = mid + 1;
        else {
          found = mid;
          hi = mid - 1;
        }
      }
      if (found === -1) {
        const last = segs[segs.length - 1];
        return { node: last.node, offset: last.node.length };
      }
      let seg = segs[found];
      if (!isEnd && offset === seg.end && segs[found + 1]?.start === offset) seg = segs[found + 1];
      if (offset < seg.start) {
        // Offset sits on a virtual line break between blocks.
        if (isEnd && found > 0) return { node: segs[found - 1].node, offset: segs[found - 1].node.length };
        return { node: seg.node, offset: 0 };
      }
      return { node: seg.node, offset: Math.min(offset - seg.start, seg.node.length) };
    }
    rangeFor(start, end) {
      const a = this.pointAt(start, false);
      const b = this.pointAt(end, true);
      if (!a || !b) return null;
      const range = document.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch {
        return null;
      }
      return range;
    }
    offsetOf(node, offset) {
      const { segs, index, text } = this.build();
      const seg = node.nodeType === Node.TEXT_NODE && index.get(node);
      if (seg) return seg.start + Math.min(offset, seg.end - seg.start);
      const point = document.createRange();
      try {
        point.setStart(node, offset);
      } catch {
        return text.length;
      }
      for (const s of segs) {
        if (point.comparePoint(s.node, 0) >= 0) return s.start;
      }
      return text.length;
    }
    selection() {
      const sel = this.root.getRootNode().getSelection?.() || getSelection();
      if (!sel || !sel.rangeCount) return [this.text().length, this.text().length];
      const range = sel.getRangeAt(0);
      if (!this.root.contains(range.startContainer)) return [this.text().length, this.text().length];
      const a = this.offsetOf(range.startContainer, range.startOffset);
      const b = this.offsetOf(range.endContainer, range.endOffset);
      return [Math.min(a, b), Math.max(a, b)];
    }
    rectsFor(issues) {
      return issues.map((issue) => {
        const range = this.rangeFor(issue.start, issue.end);
        const rects = range ? [...range.getClientRects()].filter((r) => r.width > 0.5) : [];
        return { issue, rects };
      });
    }
    select(start, end) {
      const range = this.rangeFor(start, end);
      if (!range) return false;
      this.root.focus({ preventScroll: true });
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    // Selects [start,end) and waits until the editor has seen the change.
    // Editors such as Draft.js and Lexical track the selection through
    // selectionchange, which fires asynchronously; editing before it arrives
    // applies the edit at the old caret.
    async selectSettled(start, end) {
      if (!this.select(start, end)) return false;
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener('selectionchange', done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 60);
        document.addEventListener('selectionchange', done);
      });
      await tick();
      this.invalidate();
      const [a, b] = this.selection();
      return a === start && b === end;
    }
    async replace(start, end, replacement, valid = () => true) {
      const before = this.text();
      const expected = normalizeQuotes(before.slice(0, start) + replacement + before.slice(end));
      // Chrome drops whitespace left dangling at a block or inline-element
      // edge after deleting a selection, which glues words together. Carry an
      // adjacent space (from the same text node, so formatting is kept)
      // through the edit so nothing is left dangling.
      const a = this.pointAt(start, false);
      const b = this.pointAt(end, true);
      if (b && /[ \u00A0]/.test(b.node.data?.[b.offset] || '')) {
        end++;
        replacement += ' ';
      } else if (a && a.offset > 0 && /[ \u00A0]/.test(a.node.data?.[a.offset - 1] || '')) {
        start--;
        replacement = ` ${replacement}`;
      }
      const landed = async () => {
        await tick(); // let the editor reconcile its model and DOM
        this.invalidate();
        return normalizeQuotes(this.text()) === expected;
      };
      if (!(await this.selectSettled(start, end))) return false;
      if (!valid()) return false;
      try {
        document.execCommand('insertText', false, replacement);
      } catch {}
      if (await landed()) return true;
      // The edit went somewhere else; don't stack a second attempt on top.
      if (this.text() !== before) return false;

      // Some editors ignore execCommand but accept a paste.
      if (!(await this.selectSettled(start, end))) return false;
      if (!valid()) return false;
      const data = new DataTransfer();
      data.setData('text/plain', replacement);
      this.root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return landed();
    }
  }

  // -------------------------------------------------------------------------
  // Field detection

  // `explicit` is for shortcuts and menu commands: the user picked this field,
  // so only hard opt-outs apply, not the heuristics for automatic checking.
  function usable(el, explicit) {
    if (el.readOnly || el.disabled) return false;
    if (el.closest('[data-claudely="false"],[data-gramm="false"],[data-enable-grammarly="false"]')) return false;
    if (explicit) return true;
    // Plain fields that turn spellcheck off usually hold code, tokens or URLs.
    // Rich editors (TinyMCE, many CMSs) turn it off to hide the browser's own
    // squiggles, so it says nothing about whether they want proofreading.
    if (!el.isContentEditable && el.getAttribute('spellcheck') === 'false') return false;
    if (el.closest('.cm-editor,.CodeMirror,.monaco-editor,.ace_editor')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 60 && r.height >= 14;
  }

  function editableRoot(node, explicit = false) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) return null;
    if (el instanceof HTMLTextAreaElement) return usable(el, explicit) ? el : null;
    if (el instanceof HTMLInputElement) {
      const textual = el.type === 'text' || (explicit && el.type === 'search');
      return textual && (settings.checkInputs || explicit) && usable(el, explicit) ? el : null;
    }
    if (!el.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return usable(root, explicit) ? root : null;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // -------------------------------------------------------------------------
  // Sessions: per-field proofreading state

  const sessions = new WeakMap();
  let active = null;
  let composing = false;

  class Session {
    constructor(el) {
      this.el = el;
      this.key = Math.random().toString(36).slice(2);
      this.adapter = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? new PlainAdapter(el) : new RichAdapter(el);
      // Keyed by quote-normalized paragraph text, so editors that curl quotes as
      // you type (smart-quote input rules) don't orphan their results.
      this.paraIssues = new Map(); // paragraph key -> located issues (paragraph-relative)
      this.dismissed = new Set();
      this.status = 'idle';
      this.error = null;
      this.timer = null;
      this.seq = 0;
      this.inflight = new Map(); // request id -> paragraph texts being checked
      this.lastText = null;
      this.issues = [];
    }

    reset() {
      this.paraIssues.clear();
      for (const id of this.inflight.keys()) send({ type: 'cancelCheck', fieldKey: this.key, requestId: id });
      this.inflight.clear();
      this.status = 'idle';
      this.error = null;
    }

    storeParagraph(text, issues) {
      const key = normalizeQuotes(text);
      this.paraIssues.delete(key);
      this.paraIssues.set(key, issues);
      if (this.paraIssues.size > 500) this.paraIssues.delete(this.paraIssues.keys().next().value);
    }

    computeIssues() {
      const text = this.adapter.text();
      this.lastText = text;
      const out = [];
      for (const para of splitParagraphs(text)) {
        const rel = this.paraIssues.get(normalizeQuotes(para.text));
        if (!rel) continue;
        for (const issue of rel) {
          if (this.dismissed.has(`${issue.original}\u0000${issue.replacement}`)) continue;
          if (issue.category === 'spelling' && dictionary.has(issue.original.toLowerCase())) continue;
          if (!settings.clarity && !CORRECTNESS.has(issue.category)) continue;
          out.push({
            ...issue,
            start: para.start + issue.start,
            end: para.start + issue.end,
            para,
            key: `${para.start + issue.start}:${issue.original}:${issue.replacement}`,
          });
        }
      }
      this.issues = out;
      return out;
    }

    pendingParagraphs() {
      const text = this.adapter.text();
      const caret = this.adapter.selection()[1];
      const checking = new Set([...this.inflight.values()].flatMap((texts) => [...texts]));
      const paras = splitParagraphs(text)
        .filter((p) => isCheckable(p.text) && !this.paraIssues.has(normalizeQuotes(p.text)) && !checking.has(normalizeQuotes(p.text)))
        .sort((a, b) => Math.abs(a.start - caret) - Math.abs(b.start - caret));
      const picked = [];
      const seen = new Set();
      let budget = CHECK_CHAR_BUDGET;
      for (const p of paras) {
        if (seen.has(p.text)) continue;
        if (picked.length && budget - p.text.length < 0) break;
        picked.push(p);
        seen.add(p.text);
        budget -= p.text.length;
      }
      return { picked, more: paras.length > picked.length };
    }

    scheduleCheck(delay = settings.delayMs) {
      clearTimeout(this.timer);
      if (!settings.autoCheck || !siteEnabled()) return;
      this.timer = setTimeout(() => this.runCheck(), delay);
    }

    async runCheck() {
      clearTimeout(this.timer);
      if (!siteEnabled() || !this.el.isConnected) return;
      if (composing) return this.scheduleCheck();
      const { picked, more } = this.pendingParagraphs();
      if (!picked.length) {
        if (!this.inflight.size && this.status !== 'error') this.status = 'done';
        scheduleRender();
        return;
      }
      const requestId = ++this.seq;
      this.inflight.set(requestId, new Set(picked.map((p) => normalizeQuotes(p.text))));
      this.status = 'checking';
      this.error = null;
      scheduleRender();
      const res = await send({ type: 'check', fieldKey: this.key, requestId, site: SITE, paragraphs: picked.map((p) => p.text) });
      if (!this.inflight.has(requestId)) return; // Account/model changed while this check was running.
      this.inflight.delete(requestId);
      if (res?.ok) {
        picked.forEach((p, i) => this.storeParagraph(p.text, locateIssues(p.text, res.results[i])));
        this.status = this.inflight.size ? 'checking' : 'done';
        this.error = null;
        if (more) this.scheduleCheck(50);
      } else if (!res?.cancelled) {
        this.status = 'error';
        this.error = res?.error || 'Check failed';
      } else if (!this.inflight.size && this.status === 'checking') {
        this.status = 'idle';
      }
      scheduleRender();
    }

    // Stop checks whose paragraphs have all been edited away; checks that
    // still cover unchanged paragraphs are allowed to finish.
    cancelStale() {
      if (!this.inflight.size) return;
      const current = new Set(splitParagraphs(this.adapter.text()).map((p) => normalizeQuotes(p.text)));
      for (const [requestId, texts] of this.inflight) {
        if ([...texts].some((t) => current.has(t))) continue;
        this.inflight.delete(requestId);
        send({ type: 'cancelCheck', fieldKey: this.key, requestId });
      }
    }

    // Replace [start,end) if it still contains `expected`; otherwise look for
    // a unique occurrence of it elsewhere (the text may have shifted).
    // Returns a promise; only one edit runs at a time per field.
    async replaceChecked(start, end, expected, replacement) {
      if (this.editing) return false;
      const text = this.adapter.text();
      if (normalizeQuotes(text.slice(start, end)) !== normalizeQuotes(expected)) {
        const haystack = normalizeQuotes(text);
        const needle = normalizeQuotes(expected);
        const first = haystack.indexOf(needle);
        if (first === -1 || haystack.indexOf(needle, first + 1) !== -1) return false;
        start = first;
        end = first + expected.length;
      }
      this.editing = true;
      try {
        return await this.adapter.replace(start, end, replacement);
      } finally {
        this.editing = false;
        this.adapter.invalidate();
      }
    }

    async applyIssue(issue) {
      const ok = await this.replaceChecked(issue.start, issue.end, issue.original, issue.replacement);
      if (!ok) return false;
      // Carry the paragraph's other suggestions over to its new text so they
      // stay visible without another round trip.
      const old = issue.para.text;
      const relStart = issue.start - issue.para.start;
      const relEnd = issue.end - issue.para.start;
      const updated = old.slice(0, relStart) + issue.replacement + old.slice(relEnd);
      const delta = issue.replacement.length - (relEnd - relStart);
      const remaining = (this.paraIssues.get(normalizeQuotes(old)) || [])
        .filter((i) => i.end <= relStart || i.start >= relEnd)
        .map((i) => (i.start >= relEnd ? { ...i, start: i.start + delta, end: i.end + delta } : i));
      this.storeParagraph(updated, remaining);
      return true;
    }

    // New writing must land at the captured cursor in the exact original
    // draft. Unlike proofreading, an empty insertion cannot be relocated.
    async replaceSnapshot(before, start, end, replacement, valid) {
      const canEdit = () => valid() && this.el.isConnected && !this.el.disabled && !this.el.readOnly
        && (!(this.adapter instanceof RichAdapter) || this.el.isContentEditable)
        && (!(this.adapter instanceof PlainAdapter) || this.el.maxLength < 0 || before.length - (end - start) + replacement.length <= this.el.maxLength)
        && this.adapter.text() === before;
      this.adapter.invalidate();
      if (this.editing || !canEdit()) return false;
      this.editing = true;
      try {
        return await this.adapter.replace(start, end, replacement, canEdit);
      } finally {
        this.editing = false;
        this.adapter.invalidate();
      }
    }
  }

  function sessionFor(el) {
    let s = sessions.get(el);
    if (!s) {
      s = new Session(el);
      sessions.set(el, s);
    }
    return s;
  }

  let mutationObserver = null;
  let resizeObserver = null;
  let pollTimer = null;
  let deactivateTimer = null;

  function activate(el) {
    clearTimeout(deactivateTimer);
    if (active?.el === el) return;
    deactivate();
    if (!siteEnabled()) return;
    active = sessionFor(el);
    ui.root.dataset.theme = pageIsDark(el) ? 'dark' : 'light';
    resizeObserver = new ResizeObserver(scheduleRender);
    resizeObserver.observe(el);
    if (active.adapter instanceof RichAdapter) {
      mutationObserver = new MutationObserver(() => onContentChanged());
      mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    } else {
      // Frameworks can change a textarea's value without firing input events.
      pollTimer = setInterval(() => {
        if (active && active.adapter.text() !== active.lastText) onContentChanged();
      }, 1000);
    }
    active.scheduleCheck(300);
    scheduleRender();
  }

  function deactivate() {
    if (!active) return;
    clearTimeout(active.timer);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    clearInterval(pollTimer);
    mutationObserver = resizeObserver = pollTimer = null;
    active = null;
    hideCard();
    closePanel();
    scheduleRender();
  }

  function onContentChanged() {
    if (!active) return;
    active.adapter.invalidate();
    rememberInsertion();
    active.cancelStale();
    hideCard();
    scheduleRender();
    active.scheduleCheck();
  }

  function refreshActive({ resetResults = false } = {}) {
    if (!active) {
      const el = editableRoot(deepActiveElement());
      if (el) activate(el);
      return;
    }
    if (!siteEnabled()) return deactivate();
    if (resetResults) active.reset();
    active.scheduleCheck(300);
    scheduleRender();
  }

  // -------------------------------------------------------------------------
  // UI shell

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; overflow: hidden; pointer-events: none; }
    .ul { position: absolute; height: 2px; border-radius: 1px; background: var(--c); opacity: .85; }
    .hl { position: absolute; border-radius: 2px; background: var(--c); opacity: .14; }
    .mirror { position: fixed; visibility: hidden; overflow: hidden; pointer-events: none; margin: 0; }
    .ui { font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); -webkit-font-smoothing: antialiased; }
    .ui { --bg: #ffffff; --fg: #1f1d1a; --muted: #6f6a62; --line: #e9e4dc; --soft: #f6f3ee; --accent: #c96442; --accent-fg: #fff;
          --red: #e5484d; --blue: #3e63dd; --green: #2f9e66; --shadow: 0 10px 30px rgba(30, 20, 10, .16), 0 2px 6px rgba(30, 20, 10, .08); }
    .ui[data-theme="dark"] {
      --bg: #262421; --fg: #f1ede6; --muted: #a8a196; --line: #3a3733; --soft: #302d29; --accent: #d97757; --shadow: 0 10px 30px rgba(0,0,0,.45);
    }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
    .badge { position: fixed; width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; pointer-events: auto;
             background: var(--bg); box-shadow: 0 1px 4px rgba(0,0,0,.2); opacity: .9; transition: opacity .15s, transform .15s; font-weight: 650; font-size: 11px; }
    .badge:hover { opacity: 1; transform: scale(1.08); }
    .badge svg { width: 14px; height: 14px; }
    .badge.count { color: #fff; background: var(--red); }
    .badge.count.soft { background: var(--blue); }
    .badge.error { background: var(--muted); color: #fff; }
    .badge.checking::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--accent); animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toast { position: fixed; pointer-events: none; background: var(--fg); color: var(--bg); padding: 4px 9px; border-radius: 6px; font-size: 12px; white-space: nowrap; box-shadow: var(--shadow); }
    .card, .panel { position: fixed; pointer-events: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
    .card { width: 300px; padding: 10px 12px 10px; }
    .head { display: flex; align-items: center; gap: 7px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
    .cat { font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); flex: 1; }
    .x { width: 22px; height: 22px; border-radius: 6px; color: var(--muted); font-size: 16px; line-height: 1; }
    .x:hover { background: var(--soft); color: var(--fg); }
    .msg { color: var(--muted); margin: 4px 0 8px; }
    .fix { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; text-align: left; width: 100%; padding: 7px 9px; border-radius: 7px; background: var(--soft); font-size: 14px; }
    .fix:hover { outline: 2px solid var(--accent); outline-offset: -1px; }
    .old { text-decoration: line-through; text-decoration-color: var(--red); color: var(--muted); }
    .new { font-weight: 650; color: var(--fg); }
    .arrow { color: var(--muted); }
    .actions { display: flex; gap: 4px; margin-top: 8px; }
    .btn { padding: 4px 9px; border-radius: 6px; color: var(--muted); font-size: 12px; }
    .btn:hover { background: var(--soft); color: var(--fg); }
    .btn.primary { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    .btn.primary:hover { filter: brightness(1.06); background: var(--accent); color: var(--accent-fg); }
    .btn:disabled { opacity: .5; cursor: default; }
    .panel { width: 372px; display: flex; flex-direction: column; overflow: hidden; }
    .panel > .head { padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--line); }
    .title { font-weight: 700; font-size: 14px; flex: 1; display: flex; align-items: center; gap: 7px; }
    .title svg { width: 16px; height: 16px; }
    .pill { font-size: 11px; color: var(--muted); background: var(--soft); border-radius: 99px; padding: 2px 8px; }
    .body { overflow: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 14px; }
    .tabs { display:flex; gap:22px; padding:0 14px; border-bottom:1px solid var(--line); }
    .tab { padding:11px 0 9px; border-bottom:2px solid transparent; color:var(--muted); }
    .tab[aria-selected="true"] { border-bottom-color:var(--accent); color:var(--fg); font-weight:650; }
    .write-label { display:block; font-size:14px; font-weight:600; margin-bottom:10px; }
    .write-prompt { display:block; resize:none; min-height:108px; max-height:240px; width:100%; padding:10px 11px;
      font:inherit; line-height:1.6; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; caret-color:var(--accent); }
    .write-prompt::placeholder { color:var(--muted); opacity:1; }
    .write-prompt:focus { outline:2px solid var(--accent); outline-offset:1px; }
    .write-hint { color:var(--muted); font-size:11px; margin:8px 0 18px; }
    .write-actions { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .write-actions .btn { padding:8px 11px; }
    .write-actions .primary { background:#e69376; color:#27170f; }
    .write-actions .primary:hover { background:#f0a58a; color:#27170f; }
    .write-placement { font-size:11px; color:var(--muted); }
    .write-notice { display:flex; gap:10px; align-items:center; padding:10px; border-radius:7px; background:var(--soft); font-size:12px; }
    .write-notice span { flex:1; }
    .section-title { display: flex; align-items: center; font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .section-title span { flex: 1; }
    .list { display: flex; flex-direction: column; gap: 6px; max-height: 232px; overflow: auto; overscroll-behavior: contain; }
    .item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px; border-radius: 7px; background: var(--soft); }
    .item .dot { margin-top: 6px; }
    .item-main { flex: 1; min-width: 0; }
    .item-fix { font-size: 13px; overflow-wrap: anywhere; }
    .item-msg { font-size: 12px; color: var(--muted); }
    .item-actions { display: flex; flex-direction: column; gap: 2px; }
    .empty { color: var(--muted); padding: 2px 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { padding: 5px 10px; border-radius: 99px; border: 1px solid var(--line); font-size: 12.5px; }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .custom { display: flex; gap: 6px; margin-top: 8px; }
    .custom input { flex: 1; min-width: 0; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px; outline: none; }
    .custom input:focus { border-color: var(--accent); }
    .scope { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .result { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; line-height: 1.55; max-height: 300px; overflow: auto; }
    .result del { color: var(--red); text-decoration-color: var(--red); opacity: .8; }
    .result del + ins { margin-left: 3px; }
    .result ins { color: var(--green); text-decoration: none; background: color-mix(in srgb, var(--green) 14%, transparent); border-radius: 2px; }
    .row { display: flex; gap: 6px; align-items: center; }
    .row .grow { flex: 1; }
    .loading { display: flex; align-items: center; gap: 10px; color: var(--muted); padding: 16px 0; }
    .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin .8s linear infinite; }
    .error-box { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--fg); border-radius: 8px; padding: 9px 11px; font-size: 12.5px; overflow-wrap: anywhere; }
    .error-box code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
    .kbd { font-size: 11px; color: var(--muted); }
  `;

  const LOGO = '<svg viewBox="0 0 24 24" fill="none"><path d="M17.5 7.2A7 7 0 1 0 17.5 16.8" stroke="#c96442" stroke-width="3" stroke-linecap="round"/><circle cx="18.6" cy="12" r="1.9" fill="#c96442"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="#2f9e66" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'html') el.innerHTML = v; // static markup only
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const ui = (() => {
    const host = document.createElement('claudely-root');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const root = h('div', { class: 'ui' });
    const layer = h('div', { class: 'layer' });
    const mirror = h('div', { class: 'mirror' });
    const badge = h('button', { class: 'badge', title: 'Claudely' });
    shadow.append(h('style', {}, STYLE), root);
    root.append(mirror, layer, badge);
    // Keep focus (and the selection) in the page's field when clicking our UI,
    // except for our own text inputs.
    shadow.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    return { host, shadow, root, layer, mirror, badge, card: null, panel: null, toast: null, surfaces: new Map() };
  })();

  function mountHost() {
    if (!ui.host.isConnected) document.documentElement.append(ui.host);
    mountSurface(ui.badge, 'Claudely writing assistant', 4);
  }

  // Shadow DOM retargets keyboard events; it does not isolate them from page
  // capture listeners. Separate browsing contexts keep trusted key, input,
  // composition and clipboard events off the host page's event path entirely.
  function mountSurface(element, title, gutter = 16) {
    if (ui.surfaces.has(element)) return;
    const frame = h('iframe', {
      title, 'data-claudely-ui': '',
      style: 'all:initial; position:fixed; border:0; margin:0; padding:0; background:transparent; color-scheme:normal; pointer-events:auto;',
    });
    ui.root.append(frame);
    const doc = frame.contentDocument;
    const style = doc.createElement('style');
    style.textContent = `${STYLE}
      html, body { margin:0; padding:0; background:transparent; overflow:hidden; }
      .surface { padding:${gutter}px; }
      .surface > .badge, .surface > .card, .surface > .panel {
        position:relative; inset:auto !important; margin:0;
      }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    `;
    const root = h('div', { class: 'ui surface', 'data-theme': ui.root.dataset.theme });
    doc.head.append(style);
    doc.body.append(root);
    root.append(element);
    doc.addEventListener('mousedown', (e) => {
      // Keep the source selection when applying a suggestion with the mouse.
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') e.preventDefault();
    });
    let escape = false;
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      escape = true;
    });
    doc.addEventListener('keyup', (e) => {
      if (e.key !== 'Escape' || !escape) return;
      escape = false;
      // Remove the focused frame after keyup, so the release cannot land on
      // the page and dismiss its dialogs or trigger another shortcut.
      if (ui.card) hideCard();
      else if (ui.panel) closePanel();
    });
    ui.surfaces.set(element, { frame, root, gutter });
  }

  function positionSurface(element) {
    const surface = ui.surfaces.get(element);
    if (!surface) return;
    const { frame, root, gutter } = surface;
    root.dataset.theme = ui.root.dataset.theme;
    frame.style.display = element.style.display === 'none' ? 'none' : 'block';
    if (element.style.display === 'none') return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const top = element.style.top ? parseFloat(element.style.top)
      : innerHeight - parseFloat(element.style.bottom || '0') - height;
    Object.assign(frame.style, {
      left: `${parseFloat(element.style.left || '0') - gutter}px`, top: `${top - gutter}px`,
      width: `${width + gutter * 2}px`, height: `${height + gutter * 2}px`,
    });
  }

  function surfaceRect(element) {
    const rect = element.getBoundingClientRect();
    const surface = ui.surfaces.get(element);
    if (!surface) return rect;
    const frame = surface.frame.getBoundingClientRect();
    return new DOMRect(frame.left + rect.left, frame.top + rect.top, rect.width, rect.height);
  }

  function removeSurface(element) {
    const surface = ui.surfaces.get(element);
    const focused = surface && ui.shadow.activeElement === surface.frame;
    surface?.frame.remove();
    ui.surfaces.delete(element);
    element?.remove();
    if (focused) active?.el.focus({ preventScroll: true });
  }

  // Match the page rather than the OS: a dark card on a light editor (or the
  // reverse) is jarring.
  function pageIsDark(el) {
    for (let node = el; node; node = node.parentElement) {
      const m = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (!m || (m.length === 4 && Number(m[3]) < 0.5)) continue;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark');
  }

  function categoryColor(category) {
    return CORRECTNESS.has(category) ? 'var(--red)' : 'var(--blue)';
  }

  // -------------------------------------------------------------------------
  // Rendering

  let renderQueued = false;
  let hitboxes = [];

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function visibleClip(el) {
    const r = el.getBoundingClientRect();
    let clip = {
      left: r.left + el.clientLeft,
      top: r.top + el.clientTop,
      right: r.left + el.clientLeft + (el.clientWidth || r.width),
      bottom: r.top + el.clientTop + (el.clientHeight || r.height),
    };
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      clip = {
        left: Math.max(clip.left, pr.left),
        top: Math.max(clip.top, pr.top),
        right: Math.min(clip.right, pr.right),
        bottom: Math.min(clip.bottom, pr.bottom),
      };
    }
    clip.left = Math.max(clip.left, 0);
    clip.top = Math.max(clip.top, 0);
    clip.right = Math.min(clip.right, innerWidth);
    clip.bottom = Math.min(clip.bottom, innerHeight);
    return clip;
  }

  function render() {
    if (!alive || orphaned()) return;
    const s = active;
    if (!s || !s.el.isConnected || !siteEnabled()) {
      ui.layer.replaceChildren();
      ui.badge.style.display = 'none';
      positionSurface(ui.badge);
      hitboxes = [];
      if (s && !s.el.isConnected) deactivate();
      return;
    }
    mountHost();
    const clip = visibleClip(s.el);
    const visible = clip.right - clip.left > 20 && clip.bottom - clip.top > 8;
    const issues = s.computeIssues();

    // Underlines
    hitboxes = [];
    ui.layer.replaceChildren();
    if (visible && issues.length) {
      Object.assign(ui.layer.style, {
        left: `${clip.left}px`,
        top: `${clip.top}px`,
        width: `${clip.right - clip.left}px`,
        height: `${clip.bottom - clip.top}px`,
      });
      const hovered = ui.card?.issueKey;
      for (const { issue, rects } of s.adapter.rectsFor(issues)) {
        const color = categoryColor(issue.category);
        for (const r of rects) {
          if (r.bottom < clip.top || r.top > clip.bottom || r.right < clip.left || r.left > clip.right) continue;
          if (hovered === issue.key) {
            ui.layer.append(h('div', {
              class: 'hl',
              style: `--c:${color};left:${r.left - clip.left}px;top:${r.top - clip.top}px;width:${r.width}px;height:${r.height}px`,
            }));
          }
          ui.layer.append(h('div', {
            class: 'ul',
            style: `--c:${color};left:${r.left - clip.left}px;top:${r.bottom - clip.top - 2}px;width:${r.width}px`,
          }));
          hitboxes.push({ issue, rect: r });
        }
      }
    }

    renderBadge(s, clip, visible, issues);
    if (ui.panel) {
      refreshSuggestions();
      positionPanel();
    }
    if (ui.card) {
      const current = issues.find((i) => i.key === ui.card.issueKey);
      if (!current) hideCard();
    }
  }

  function renderBadge(s, clip, visible, issues) {
    const b = ui.badge;
    if (!visible) {
      b.style.display = 'none';
      positionSurface(b);
      return;
    }
    const r = s.el.getBoundingClientRect();
    const singleLine = r.height < 44;
    const size = 22;
    // Leave room for a textarea's resize grip in the corner.
    const inset = s.el instanceof HTMLTextAreaElement && getComputedStyle(s.el).resize !== 'none' ? 18 : 6;
    const left = Math.min(r.right, clip.right) - size - inset;
    const top = singleLine ? r.top + (r.height - size) / 2 : Math.min(r.bottom, clip.bottom) - size - 6;
    Object.assign(b.style, { display: 'grid', left: `${left}px`, top: `${Math.max(top, clip.top)}px` });

    const correctness = issues.filter((i) => CORRECTNESS.has(i.category)).length;
    b.className = 'badge';
    b.textContent = '';
    if (s.status === 'checking') {
      b.classList.add('checking');
      b.innerHTML = LOGO;
      b.title = 'Claudely is checking…';
    } else if (s.status === 'error') {
      b.classList.add('error');
      b.textContent = '!';
      b.title = `Claudely: ${s.error}`;
    } else if (issues.length) {
      b.classList.add('count');
      if (!correctness) b.classList.add('soft');
      b.textContent = issues.length > 99 ? '99+' : String(issues.length);
      b.title = `${issues.length} suggestion${issues.length === 1 ? '' : 's'}`;
    } else if (s.status === 'done') {
      b.innerHTML = CHECK;
      b.title = 'Claudely: looks good';
    } else {
      b.innerHTML = LOGO;
      b.title = 'Claudely';
    }
    positionSurface(b);
  }

  ui.badge.addEventListener('click', () => {
    if (ui.panel) closePanel();
    else openPanel();
  });

  function showToast(text, anchor = null) {
    ui.toast?.remove();
    mountHost();
    // Next to the badge, or above the field's corner when there's no badge.
    const target = anchor || (ui.badge.offsetWidth ? ui.badge : active?.el);
    const b = target ? surfaceRect(target) : new DOMRect(innerWidth - 8, innerHeight - 8, 0, 0);
    const t = h('div', { class: 'toast' }, text);
    ui.root.append(t);
    const w = t.offsetWidth;
    Object.assign(t.style, { left: `${Math.max(8, b.right - w)}px`, top: `${Math.max(8, b.top - 30)}px` });
    ui.toast = t;
    setTimeout(() => {
      if (ui.toast === t) {
        t.remove();
        ui.toast = null;
      }
    }, 2200);
  }

  // -------------------------------------------------------------------------
  // Suggestion card

  let hoverTimer = null;
  let hideTimer = null;

  function showCard(issue, rect) {
    hideCard();
    mountHost();
    const color = categoryColor(issue.category);
    const card = h('div', { class: 'card', style: `--c:${color}` },
      h('div', { class: 'head' },
        h('span', { class: 'dot' }),
        h('span', { class: 'cat' }, CATEGORY_LABEL[issue.category]),
        h('button', { class: 'x', title: 'Close', onclick: hideCard }, '×'),
      ),
      issue.message ? h('div', { class: 'msg' }, issue.message) : null,
      h('button', { class: 'fix', title: 'Accept suggestion', onclick: () => acceptIssue(issue.key) },
        h('span', { class: 'old' }, issue.original),
        h('span', { class: 'arrow' }, '→'),
        h('span', { class: 'new' }, issue.replacement || '(remove)'),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => dismissIssue(issue) }, 'Dismiss'),
        issue.category === 'spelling' && /^\S+$/.test(issue.original)
          ? h('button', { class: 'btn', onclick: () => addToDictionary(issue.original) }, 'Add to dictionary')
          : null,
      ),
    );
    card.issueKey = issue.key;
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', () => scheduleHideCard());
    mountSurface(card, 'Claudely suggestion');
    ui.card = card;

    const viewportWidth = document.documentElement.clientWidth;
    const width = Math.min(300, viewportWidth - 16);
    card.style.width = `${width}px`;
    const left = Math.min(Math.max(8, rect.left), viewportWidth - width - 8);
    const height = card.offsetHeight;
    const below = rect.bottom + 6;
    const top = below + height > innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    positionSurface(card);
    scheduleRender();
  }

  function hideCard() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    if (!ui.card) return;
    removeSurface(ui.card);
    ui.card = null;
    scheduleRender();
  }

  function scheduleHideCard() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 350);
  }

  async function acceptIssue(key) {
    const s = active;
    if (!s) return;
    s.computeIssues();
    const issue = s.issues.find((i) => i.key === key);
    hideCard();
    if (!issue) return;
    if (!(await s.applyIssue(issue))) showToast(APPLY_FAILED);
    s.adapter.invalidate();
    scheduleRender();
    if (ui.panel) renderPanel();
  }

  function dismissIssue(issue) {
    active?.dismissed.add(`${issue.original}\u0000${issue.replacement}`);
    hideCard();
    scheduleRender();
    if (ui.panel) renderPanel();
  }

  async function addToDictionary(word) {
    const { dictionary: words = [] } = await chrome.storage.local.get('dictionary');
    if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
    await chrome.storage.local.set({ dictionary: words });
    dictionary.add(word.toLowerCase());
    hideCard();
    scheduleRender();
  }

  function hitTest(x, y) {
    return hitboxes.find(({ rect: r }) => x >= r.left && x <= r.right && y >= r.top - 1 && y <= r.bottom + 3);
  }

  addEventListener('mousemove', (e) => {
    if (!active || (!hitboxes.length && !ui.card)) return;
    if (e.composedPath().includes(ui.host)) {
      clearTimeout(hideTimer);
      return;
    }
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      clearTimeout(hideTimer);
      if (ui.card?.issueKey !== hit.issue.key) {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showCard(hit.issue, hit.rect), 260);
      }
    } else {
      clearTimeout(hoverTimer);
      if (ui.card) scheduleHideCard();
    }
  }, { passive: true, signal });

  addEventListener('mouseup', (e) => {
    if (!active || e.composedPath().includes(ui.host)) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit && ui.card?.issueKey !== hit.issue.key) showCard(hit.issue, hit.rect);
  }, { capture: true, signal });

  // -------------------------------------------------------------------------
  // Panel: all suggestions + rewrite tools

  let panelState = null;

  function captureScope(s) {
    const text = s.adapter.text();
    const [a, b] = s.adapter.selection();
    if (b > a && text.slice(a, b).trim()) {
      return { start: a, end: b, text: text.slice(a, b), label: 'selection', full: text };
    }
    return { start: 0, end: text.length, text, label: 'whole text', full: text };
  }

  function captureInsertion(s) {
    s.adapter.invalidate();
    const full = s.adapter.text();
    const [a, b] = s.adapter.selection();
    const start = Math.max(0, Math.min(a, full.length));
    const end = Math.max(start, Math.min(b, full.length));
    return { start, end, text: full.slice(start, end), full };
  }

  function rememberInsertion() {
    if (!panelState || !active) return;
    const focused = deepActiveElement();
    if (focused !== active.el && !active.el.contains(focused)) return;
    panelState.writeScope = captureInsertion(active);
  }

  function openPanel(initial = {}) {
    if (!active) return;
    mountHost();
    hideCard();
    if (panelState?.request) panelState.request.cancelled = true;
    const scope = captureScope(active);
    panelState = { view: 'main', mode: scope.full.trim() ? 'rewrite' : 'write',
      scope, writeScope: captureInsertion(active), writePrompt: '', ...initial };
    if (!ui.panel) {
      ui.panel = h('div', { class: 'panel' });
      mountSurface(ui.panel, 'Claudely writing panel');
    }
    renderPanel();
  }

  function closePanel() {
    if (panelState?.request) panelState.request.cancelled = true;
    removeSurface(ui.panel);
    ui.panel = null;
    panelState = null;
  }

  function positionPanel() {
    const p = ui.panel;
    if (!p) return;
    const b = ui.badge.style.display === 'none' && active
      ? active.el.getBoundingClientRect()
      : surfaceRect(ui.badge);
    const viewportWidth = document.documentElement.clientWidth;
    const width = Math.min(372, viewportWidth - 16);
    p.style.width = `${width}px`;
    const left = Math.min(Math.max(8, b.right - width), viewportWidth - width - 8);
    const above = b.top - 16;
    const below = innerHeight - b.bottom - 16;
    p.style.left = `${left}px`;
    if (above > 360 || above > below) {
      p.style.top = '';
      p.style.bottom = `${innerHeight - b.top + 8}px`;
      p.style.maxHeight = `${Math.max(200, above)}px`;
    } else {
      p.style.bottom = '';
      p.style.top = `${b.bottom + 8}px`;
      p.style.maxHeight = `${Math.max(200, below)}px`;
    }
    positionSurface(p);
  }

  function providerLabel() {
    return { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }[settings.provider] || settings.provider;
  }

  function switchMode(mode, focus = false) {
    const st = panelState;
    if (!st || st.request || st.view !== 'main') return;
    st.mode = mode;
    st.error = null;
    renderPanel();
    if (focus) ui.panel.querySelector(`#claudely-tab-${mode}`)?.focus();
  }

  function panelTabs(st) {
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Writing mode' },
      ['write', 'rewrite', 'check'].map((mode) => h('button', {
        class: 'tab', id: `claudely-tab-${mode}`, role: 'tab',
        'aria-controls': 'claudely-panel-body', 'aria-selected': String(st.mode === mode),
        tabindex: st.mode === mode ? '0' : '-1', disabled: Boolean(st.request) || st.view !== 'main',
        onclick: () => switchMode(mode),
      }, { write: 'Write', rewrite: 'Rewrite', check: 'Check' }[mode])),
    );
    tabs.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const modes = ['write', 'rewrite', 'check'];
      const index = modes.indexOf(st.mode);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      switchMode(modes[next], true);
    });
    return tabs;
  }

  function renderPanel() {
    const s = active;
    const st = panelState;
    if (!ui.panel || !s || !st) return;
    const body = h('div', { class: 'body', id: 'claudely-panel-body', role: 'tabpanel', 'aria-labelledby': `claudely-tab-${st.mode}` });
    const header = h('div', { class: 'head' },
      h('div', { class: 'title', html: LOGO }, 'Claudely'),
      h('span', { class: 'pill' }, providerLabel()),
      h('button', { class: 'x', title: 'Settings', onclick: () => send({ type: 'openOptions' }) }, '⚙'),
      h('button', { class: 'x', title: 'Close (Esc)', onclick: closePanel }, '×'),
    );
    ui.panel.replaceChildren(header, panelTabs(st), body);

    if (st.view === 'loading') {
      body.append(
        h('div', { class: 'loading' }, h('div', { class: 'spinner' }), `Rewriting ${st.scope.label} with ${providerLabel()}…`),
        h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: backToMain }, 'Cancel')),
      );
    } else if (st.view === 'result') {
      body.append(
        h('div', { class: 'scope' }, `${st.title} · ${st.scope.label}`),
        h('div', { class: 'result' }, ...diffNodes(st.scope.text, st.result)),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: applyRewrite }, 'Replace'),
          h('button', { class: 'btn', onclick: copyRewrite }, 'Copy'),
          h('button', { class: 'btn', onclick: () => runRewrite(st.action, st.instruction, st.title) }, 'Retry'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onclick: backToMain }, 'Back'),
        ),
      );
    } else {
      st.suggestionsEl = null;
      if (st.mode === 'check') {
        st.suggestionsEl = suggestionsSection(s);
        st.suggestionsSig = suggestionsSignature(s);
        body.append(st.suggestionsEl);
      } else if (st.mode === 'write') body.append(writeSection(st));
      else body.append(rewriteSection(st));
      if (st.error) body.prepend(errorBox(st.error));
      else if (st.mode === 'check' && s.status === 'error') body.prepend(errorBox(s.error));
    }
    positionPanel();
    st.focusInput?.focus();
    st.focusInput = null;
  }

  function suggestionsSignature(s) {
    return `${s.status}|${s.issues.map((i) => i.key).join(',')}`;
  }

  // Called on every render: swap in a fresh suggestions list when results
  // change, without touching the rest of the panel (e.g. a half-typed prompt).
  function refreshSuggestions() {
    const st = panelState;
    if (st?.placementEl?.isConnected) st.placementEl.textContent = insertionLabel(st.writeScope);
    if (!active || st?.view !== 'main' || !st.suggestionsEl?.isConnected) return;
    const sig = suggestionsSignature(active);
    if (sig === st.suggestionsSig) return;
    const next = suggestionsSection(active);
    st.suggestionsEl.replaceWith(next);
    st.suggestionsEl = next;
    st.suggestionsSig = sig;
    positionPanel();
  }

  function errorBox(message) {
    const box = h('div', { class: 'error-box' });
    if (/not installed/i.test(message)) {
      box.append('The Claudely host isn\'t installed. In the claudely folder run ', h('code', {}, './host/install.sh'), ', then reload the extension.');
    } else {
      box.append(message);
    }
    return box;
  }

  function suggestionsSection(s) {
    const issues = s.issues;
    const title = h('div', { class: 'section-title' },
      h('span', {}, issues.length ? `Suggestions · ${issues.length}` : 'Suggestions'),
      issues.length > 1 ? h('button', { class: 'btn', onclick: acceptAll }, 'Accept all') : null,
      h('button', { class: 'btn', onclick: () => checkNow() }, s.status === 'checking' ? 'Checking…' : 'Check now'),
    );
    let content;
    if (issues.length) {
      content = h('div', { class: 'list' }, issues.slice(0, 50).map((issue) =>
        h('div', { class: 'item', style: `--c:${categoryColor(issue.category)}` },
          h('span', { class: 'dot' }),
          h('div', { class: 'item-main' },
            h('div', { class: 'item-fix' },
              h('span', { class: 'old' }, issue.original), ' ',
              h('span', { class: 'arrow' }, '→'), ' ',
              h('span', { class: 'new' }, issue.replacement || '(remove)'),
            ),
            issue.message ? h('div', { class: 'item-msg' }, issue.message) : null,
          ),
          h('div', { class: 'item-actions' },
            h('button', { class: 'btn primary', onclick: () => acceptIssue(issue.key) }, 'Accept'),
            h('button', { class: 'btn', onclick: () => dismissIssue(issue) }, 'Dismiss'),
          ),
        ),
      ));
    } else {
      const label = s.status === 'error' ? 'Couldn’t check this text.'
        : s.status === 'checking' ? 'Checking your writing…'
        : s.status === 'done' ? 'No issues found.'
          : settings.autoCheck ? 'Start typing and Claudely will check as you go.' : 'Auto-check is off. Use “Check now”.';
      content = h('div', { class: 'empty' }, label);
    }
    return h('div', {}, title, content);
  }

  function rewriteSection(st) {
    const words = (st.scope.text.match(/\S+/g) || []).length;
    const input = h('input', { placeholder: 'Or describe a change… e.g. “make it sound like me”', 'aria-label': 'Custom rewrite instruction' });
    const go = () => {
      const instruction = input.value.trim();
      if (instruction) runRewrite('custom', instruction, `“${instruction}”`);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        go();
      }
    });
    return h('div', {},
      h('div', { class: 'section-title' }, h('span', {}, 'Rewrite')),
      h('div', { class: 'scope' }, words ? `Applies to the ${st.scope.label} (${words} word${words === 1 ? '' : 's'}).` : 'Write something first.'),
      h('div', { class: 'chips' }, REWRITES.map((r) =>
        h('button', { class: 'chip', disabled: !words, onclick: () => runRewrite(r.id, null, r.label) }, r.label))),
      h('div', { class: 'custom' }, input, h('button', { class: 'btn primary', disabled: !words, onclick: go }, 'Go')),
      h('div', { class: 'kbd', style: 'margin-top:8px' }, 'Alt+Shift+G quick-fixes · Alt+Shift+W opens this panel'),
    );
  }

  function backToMain() {
    if (panelState?.request) panelState.request.cancelled = true;
    panelState = { ...panelState, view: 'main', request: null, scope: captureScope(active) };
    renderPanel();
  }

  function insertionLabel(scope) {
    return !scope.full ? 'Into this empty field' : scope.end > scope.start ? 'Replaces selected text' : 'Inserts at your cursor';
  }

  function writeSection(st) {
    const busy = Boolean(st.request);
    const input = h('textarea', { id: 'claudely-write-prompt', class: 'write-prompt',
      placeholder: 'Describe a post, reply, email, or anything else…', readonly: busy });
    input.value = st.writePrompt;
    const button = h('button', { class: 'btn primary', disabled: busy ? st.request.applying : !st.writePrompt.trim(),
      onclick: () => busy ? cancelWriting() : runWrite() }, busy ? 'Cancel writing' : 'Write in text box');
    input.addEventListener('input', () => {
      st.writePrompt = input.value;
      button.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (!st.request) runWrite();
      }
    });
    st.placementEl = h('span', { class: 'write-placement' }, insertionLabel(st.writeScope));
    const section = h('div', {},
      h('label', { class: 'write-label', for: 'claudely-write-prompt' }, 'What would you like to write?'), input,
      h('p', { class: 'write-hint', role: 'status' }, busy ? `Writing with ${providerLabel()}…` : 'Describe the idea, tone, and any details to include.'),
      h('div', { class: 'write-actions' }, st.placementEl, button),
      h('p', { class: 'kbd', style: 'margin:10px 0 0' }, '⌘ / Ctrl + Enter to write · Enter for a new line'),
    );
    if (st.notice) section.append(h('div', { class: 'write-notice', role: 'status', style: 'margin-top:14px' },
      h('span', {}, st.notice), st.undo ? h('button', { class: 'btn', onclick: undoWriting }, 'Undo') : null));
    if (st.generatedText && st.error) section.append(h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn', onclick: () => copyText(st.generatedText) }, 'Copy generated text')));
    return section;
  }

  function cancelWriting() {
    const st = panelState;
    if (!st?.request || st.request.applying) return;
    st.request.cancelled = true;
    Object.assign(st, { request: null, notice: 'Writing canceled. Your field is unchanged.' });
    renderPanel();
  }

  async function runWrite() {
    const st = panelState;
    const s = active;
    if (!st || !s || st.request || !st.writePrompt.trim()) return;
    const scope = { ...st.writeScope };
    const request = { cancelled: false };
    Object.assign(st, { request, error: null, notice: null, generatedText: null });
    renderPanel();
    const res = await send({ type: 'write', instruction: st.writePrompt.trim(), site: SITE, text: scope.text,
      contextBefore: scope.full.slice(Math.max(0, scope.start - 600), scope.start),
      contextAfter: scope.full.slice(scope.end, scope.end + 600) });
    const valid = () => !request.cancelled && panelState === st && active === s && alive && siteEnabled();
    if (!valid()) return;
    if (!res?.ok || typeof res.text !== 'string' || !res.text.trim()) {
      Object.assign(st, { request: null, error: res?.error || 'No text was generated. Try again.' });
      renderPanel();
      return;
    }
    st.generatedText = res.text;
    request.applying = true;
    renderPanel();
    const singleLine = s.adapter instanceof PlainAdapter && s.adapter.isInput;
    let inserted = singleLine ? res.text.replace(/[\r\n]+/g, ' ') : res.text;
    if (scope.start === scope.end) {
      const separator = singleLine ? ' ' : '\n\n';
      if (scope.start && !/\s$/.test(scope.full.slice(0, scope.start)) && !/^\s/.test(inserted)) inserted = separator + inserted;
      if (scope.end < scope.full.length && !/^\s/.test(scope.full.slice(scope.end)) && !/\s$/.test(inserted)) inserted += separator;
    }
    const ok = await s.replaceSnapshot(scope.full, scope.start, scope.end, inserted, valid);
    if (!valid()) return;
    s.adapter.invalidate();
    const after = s.adapter.text();
    st.request = null;
    if (!ok) {
      st.error = 'Couldn’t insert the text. Your field may have changed. Copy the generated text or try again.';
    } else {
      const insertedEnd = after.length - (scope.full.length - scope.end);
      st.undo = { session: s, before: scope.full, after, start: scope.start, end: insertedEnd, text: scope.text };
      st.notice = 'Written in your text box.';
      st.scope = captureScope(s);
    }
    st.writeScope = captureInsertion(s);
    renderPanel();
    scheduleRender();
  }

  async function undoWriting() {
    const st = panelState;
    const undo = st?.undo;
    if (!undo || st.request || active !== undo.session) return;
    const s = undo.session;
    const request = { cancelled: false };
    st.request = request;
    const ok = await s.replaceSnapshot(undo.after, undo.start, undo.end, undo.text,
      () => panelState === st && active === s && !request.cancelled && alive && siteEnabled());
    if (panelState !== st || request.cancelled) return;
    Object.assign(st, { request: null, undo: null, notice: ok ? 'Insertion undone. Your previous text is restored.' : null,
      error: ok ? null : 'Your draft has changed since insertion. Undo was skipped to preserve your edits.',
      writeScope: captureInsertion(s), scope: captureScope(s) });
    renderPanel();
    scheduleRender();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied');
    } catch {
      showToast('Copy failed');
    }
  }

  async function runRewrite(action, instruction, title) {
    const st = panelState;
    if (!st || !st.scope.text.trim()) return;
    const request = { cancelled: false };
    Object.assign(st, { view: 'loading', action, instruction, title, request, error: null });
    renderPanel();
    const { scope } = st;
    const res = await send({
      type: 'rewrite',
      action,
      instruction,
      site: SITE,
      text: scope.text,
      contextBefore: scope.full.slice(Math.max(0, scope.start - 600), scope.start),
      contextAfter: scope.full.slice(scope.end, scope.end + 600),
    });
    if (request.cancelled || panelState !== st) return;
    if (!res?.ok) {
      Object.assign(st, { view: 'main', error: res?.error || 'Rewrite failed' });
    } else {
      Object.assign(st, { view: 'result', result: res.text });
    }
    renderPanel();
  }

  function markClean(s, text) {
    for (const p of splitParagraphs(text)) s.storeParagraph(p.text, []);
  }

  async function applyRewrite() {
    const s = active;
    const st = panelState;
    if (!s || !st) return;
    if (!(await s.replaceChecked(st.scope.start, st.scope.end, st.scope.text, st.result))) {
      if (panelState !== st) return showToast(APPLY_FAILED);
      st.error = 'Couldn’t replace the text in this field. Copy the result instead.';
      st.view = 'main';
      renderPanel();
      return;
    }
    markClean(s, st.result);
    closePanel();
    showToast('Replaced');
    scheduleRender();
  }

  async function copyRewrite() {
    await copyText(panelState.result);
  }

  async function acceptAll() {
    const s = active;
    if (!s || s.acceptingAll) return;
    s.acceptingAll = true;
    let failed = 0;
    // Apply right-to-left so earlier offsets stay valid.
    const keys = [...s.issues].sort((a, b) => b.start - a.start).map((i) => i.key);
    for (const key of keys) {
      s.computeIssues();
      const issue = s.issues.find((i) => i.key === key);
      if (!issue || !(await s.applyIssue(issue))) failed++;
    }
    s.acceptingAll = false;
    s.adapter.invalidate();
    scheduleRender();
    if (failed) showToast(`${failed} suggestion${failed === 1 ? '' : 's'} could not be applied`);
    if (ui.panel) renderPanel();
  }

  function checkNow() {
    const s = active;
    if (!s) return;
    // Drop results for the current paragraphs so they're re-checked.
    for (const p of splitParagraphs(s.adapter.text())) s.paraIssues.delete(normalizeQuotes(p.text));
    s.dismissed.clear();
    s.runCheck().then(() => ui.panel && renderPanel());
    if (ui.panel) renderPanel();
  }

  async function quickFix() {
    const s = active;
    if (!s) return;
    const scope = captureScope(s);
    if (!scope.text.trim()) return;
    s.status = 'checking';
    scheduleRender();
    const res = await send({
      type: 'rewrite',
      action: 'fix',
      site: SITE,
      text: scope.text,
      contextBefore: scope.full.slice(Math.max(0, scope.start - 400), scope.start),
      contextAfter: scope.full.slice(scope.end, scope.end + 400),
    });
    s.status = 'done';
    if (!res?.ok) {
      s.status = 'error';
      s.error = res?.error || 'Quick fix failed';
    } else if (res.text === scope.text) {
      showToast('No changes needed');
    } else if (await s.replaceChecked(scope.start, scope.end, scope.text, res.text)) {
      markClean(s, res.text);
      showToast('Fixed ✓  (Ctrl/⌘+Z to undo)');
    } else {
      showToast(APPLY_FAILED);
    }
    scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Diff (word level) for rewrite previews

  function tokenize(s) {
    return s.match(/\s+|[\p{L}\p{N}'’_-]+|[^\s\p{L}\p{N}]/gu) || [];
  }

  function diffNodes(a, b) {
    const x = tokenize(a);
    const y = tokenize(b);
    const n = x.length;
    const m = y.length;
    if (n * m > 1_500_000) return [b];
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const ops = [];
    const push = (op, t) => {
      const last = ops[ops.length - 1];
      if (last?.op === op) last.t += t;
      else ops.push({ op, t });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        push('eq', x[i]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) push('del', x[i++]);
      else push('ins', y[j++]);
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('ins', y[j++]);
    return ops.map(({ op, t }) => (op === 'eq' ? t : h(op, {}, t)));
  }

  // -------------------------------------------------------------------------
  // Page events

  document.addEventListener('focusin', (e) => {
    if (orphaned()) return;
    const target = e.composedPath()[0];
    if (target === ui.host || e.composedPath().includes(ui.host)) return;
    const el = editableRoot(target);
    if (el) activate(el);
    else if (active && !ui.panel) deactivate();
  }, { capture: true, signal });

  document.addEventListener('focusout', () => {
    rememberInsertion();
    clearTimeout(deactivateTimer);
    deactivateTimer = setTimeout(() => {
      if (!active || ui.panel) return;
      const a = deepActiveElement();
      if (a === ui.host || active.el === a || active.el.contains(a)) return;
      deactivate();
    }, 200);
  }, { capture: true, signal });

  document.addEventListener('selectionchange', rememberInsertion, { signal });
  document.addEventListener('select', rememberInsertion, { capture: true, signal });

  document.addEventListener('input', (e) => {
    if (!active) return;
    const target = e.composedPath()[0];
    if (target === active.el || active.el.contains(target)) onContentChanged();
  }, { capture: true, signal });

  document.addEventListener('compositionstart', () => (composing = true), { capture: true, signal });
  document.addEventListener('compositionend', () => {
    composing = false;
    onContentChanged();
  }, { capture: true, signal });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!ui.card && !ui.panel)) return;
    e.stopPropagation();
    if (ui.card) hideCard();
    else closePanel();
  }, { capture: true, signal });

  addEventListener('scroll', () => {
    if (active) {
      if (ui.card) hideCard();
      scheduleRender();
    }
  }, { capture: true, passive: true, signal });
  addEventListener('resize', scheduleRender, { passive: true, signal });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'command' || !alive) return;
    // Menu clicks are sent to the frame that was clicked; shortcuts go to
    // every frame, so only the focused one acts on them.
    if (!msg.targeted && !document.hasFocus()) return;
    const el = editableRoot(deepActiveElement(), true);
    if (!el) return;
    if (!siteEnabled()) {
      showToast(settings.enabled ? 'Claudely is off for this site' : 'Claudely is turned off', el);
      return;
    }
    if (active?.el !== el) activate(el);
    if (!active) return;
    if (msg.command === 'quick-fix') quickFix();
    else if (msg.command === 'open-panel') ui.panel ? closePanel() : openPanel();
    else if (msg.command === 'check-now') checkNow();
    else if (msg.command === 'rewrite') {
      const preset = REWRITES.find((r) => r.id === msg.action);
      openPanel();
      runRewrite(msg.action, null, preset?.label || 'Rewrite');
    }
  });

  // Test hook for tools/cdp.mjs (`xeval`). It lives in the extension's
  // isolated world, so pages can't see or call it.
  globalThis.__claudelyDebug = {
    state() {
      const s = active;
      if (!s) return { active: false };
      s.computeIssues();
      return {
        active: true,
        field: `${s.el.tagName.toLowerCase()}${s.el.id ? `#${s.el.id}` : ''}.${[...s.el.classList].join('.')}`,
        status: s.status,
        error: s.error,
        text: s.adapter.text(),
        issues: s.issues.map((i) => `${i.original} -> ${i.replacement}`),
        rects: s.adapter.rectsFor(s.issues).map((r) => r.rects.length),
        panel: Boolean(ui.panel),
        panelView: panelState?.view,
        panelMode: panelState?.mode,
        panelError: panelState?.error,
        writeNotice: panelState?.notice,
        result: panelState?.result,
      };
    },
    async accept(n = 0) {
      const issue = active?.issues[n];
      if (!issue) return false;
      const ok = await active.applyIssue(issue);
      scheduleRender();
      return ok;
    },
    acceptAll,
    applyRewrite,
  };

  function teardown() {
    if (!alive) return;
    alive = false;
    deactivate();
    pageListeners.abort();
    ui.host.remove();
  }
  document.addEventListener('claudely:replaced', teardown, { signal });

  // chrome.runtime.id disappears once the extension is reloaded or removed.
  function orphaned() {
    if (chrome.runtime?.id) return false;
    teardown();
    return true;
  }

  // The field may already be focused when the script loads.
  const initial = editableRoot(deepActiveElement());
  if (initial) activate(initial);
})();
