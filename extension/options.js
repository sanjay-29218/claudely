const DEFAULTS = globalThis.CLAUDELY_DEFAULTS;
const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['styleNotes', 'dialect', 'codexCheckEffort', 'codexRewriteEffort'];
const TOGGLES = ['autoCheck', 'clarity', 'checkInputs'];
const EFFORTS = ['low', 'medium', 'high'];

let settings = { ...DEFAULTS };
let savedTimer = null;

async function save(patch) {
  Object.assign(settings, patch);
  await chrome.storage.sync.set(patch);
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

function renderProvider() {
  $('testResult').textContent = '';
  for (const el of document.querySelectorAll('[data-provider]')) {
    el.style.display = el.dataset.provider === settings.provider ? '' : 'none';
  }
}

function renderChips(container, items, onRemove) {
  container.replaceChildren(...items.map((item) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Remove ${item}`;
    remove.onclick = () => onRemove(item);
    chip.append(item, remove);
    return chip;
  }));
  if (!items.length) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'None yet.';
    container.append(none);
  }
}

async function renderDictionary() {
  const { dictionary = [] } = await chrome.storage.local.get('dictionary');
  renderChips($('dictionary'), dictionary, async (word) => {
    await chrome.storage.local.set({ dictionary: dictionary.filter((w) => w !== word) });
    renderDictionary();
  });
}

function renderSites() {
  renderChips($('sites'), settings.disabledSites, (site) => {
    save({ disabledSites: settings.disabledSites.filter((s) => s !== site) });
    renderSites();
  });
}

async function testConnection() {
  const out = $('testResult');
  $('test').disabled = true;
  out.textContent = `Asking ${globalThis.CLAUDELY_PROVIDER_NAMES[settings.provider]} to fix a sentence…`;
  try {
  const started = performance.now();
  const res = await chrome.runtime.sendMessage({
    type: 'rewrite',
    action: 'fix',
    site: 'the Claudely settings page',
    text: 'their going too the park tomorow.',
  });
  const ms = Math.round(performance.now() - started);
  out.textContent = res.ok ? `✓ ${ms} ms → “${res.text}”` : `✗ ${res.error}`;
  } catch (err) { out.textContent = err.message; }
  finally { $('test').disabled = false; }
}

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  for (const id of ['codexCheckEffort', 'codexRewriteEffort']) {
    $(id).replaceChildren(...EFFORTS.map((e) => new Option(e, e)));
  }
  for (const id of TEXT_FIELDS) {
    $(id).value = settings[id];
    $(id).addEventListener('change', (e) => {
      const value = e.target.value.trim();
      if (!value && id !== 'styleNotes') {
        e.target.value = DEFAULTS[id];
        return save({ [id]: DEFAULTS[id] });
      }
      save({ [id]: value });
    });
  }
  for (const id of TOGGLES) {
    $(id).checked = settings[id];
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }
  $('delayMs').value = settings.delayMs;
  $('delayMs').addEventListener('change', (e) => {
    const value = Math.min(10000, Math.max(300, Number(e.target.value) || DEFAULTS.delayMs));
    e.target.value = value;
    save({ delayMs: value });
  });

  renderProvider();
  const providerUI = new globalThis.ClaudelyProviderUI(settings, save, renderProvider);
  providerUI.init();

  const addWord = async () => {
    const word = $('newWord').value.trim();
    if (!word) return;
    const { dictionary = [] } = await chrome.storage.local.get('dictionary');
    if (!dictionary.includes(word)) await chrome.storage.local.set({ dictionary: [...dictionary, word] });
    $('newWord').value = '';
    renderDictionary();
  };
  $('addWord').onclick = addWord;
  $('newWord').onkeydown = (e) => e.key === 'Enter' && addWord();

  const addSite = () => {
    let site = $('newSite').value.trim().toLowerCase();
    try {
      if (site.includes('/')) site = new URL(site.includes('://') ? site : `https://${site}`).hostname;
    } catch {}
    if (!site || settings.disabledSites.includes(site)) return;
    save({ disabledSites: [...settings.disabledSites, site] });
    $('newSite').value = '';
    renderSites();
  };
  $('addSite').onclick = addSite;
  $('newSite').onkeydown = (e) => e.key === 'Enter' && addSite();

  $('test').onclick = testConnection;
  $('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

  renderDictionary();
  renderSites();

}

init();
