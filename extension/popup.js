const DEFAULTS = globalThis.CLAUDELY_DEFAULTS;
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let site = null;

function save(patch) {
  Object.assign(settings, patch);
  return chrome.storage.sync.set(patch);
}

function siteDisabled() {
  return settings.disabledSites.some((d) => site === d || site.endsWith(`.${d}`));
}

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url || '');
    if (/^https?:$/.test(url.protocol)) site = url.hostname;
  } catch {}

  $('enabled').checked = settings.enabled;
  $('autoCheck').checked = settings.autoCheck;
  if (site) {
    $('siteName').textContent = site;
    $('site').checked = !siteDisabled();
  } else {
    $('site').disabled = true;
  }


  $('enabled').onchange = (e) => save({ enabled: e.target.checked });
  $('autoCheck').onchange = (e) => save({ autoCheck: e.target.checked });
  $('site').onchange = (e) => {
    const others = settings.disabledSites.filter((d) => !(site === d || site.endsWith(`.${d}`)));
    save({ disabledSites: e.target.checked ? others : [...others, site] });
  };
  $('options').onclick = () => chrome.runtime.openOptionsPage();

  const providerUI = new globalThis.ClaudelyProviderUI(settings, save);
  await providerUI.init();
  const { checks = 0, rewrites = 0, cacheHits = 0 } = providerUI.status?.stats || {};
  $('stats').textContent = `${checks} checks · ${rewrites} rewrites · ${cacheHits} cached`;
}

init();
