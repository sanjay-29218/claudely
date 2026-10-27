// Shared account and model controls for the popup and Settings.
globalThis.ClaudelyProviderUI = class {
  constructor(settings, save, onProvider = () => {}) {
    this.settings = settings;
    this.save = save;
    this.onProvider = onProvider;
    this.generation = 0;
    this.$ = (id) => document.getElementById(id);
  }

  async init() {
    this.$('provider').onchange = async (e) => {
      await this.save({ provider: e.target.value });
      this.onProvider();
      this.render();
      this.refresh();
    };
    this.$('connection').onchange = async (e) => {
      await this.save({ [`${this.settings.provider}Connection`]: e.target.value });
      this.refresh();
    };
    for (const kind of ['Check', 'Rewrite']) {
      const select = this.$(`${kind.toLowerCase()}Model`);
      const custom = this.$(`${kind.toLowerCase()}CustomModel`);
      select.onchange = async () => {
        custom.hidden = select.value !== '__custom';
        if (!custom.hidden) { custom.focus(); return; }
        await this.save({ [`${this.settings.provider}${kind}Model`]: select.value });
      };
      custom.onchange = async () => {
        const value = custom.value.trim();
        if (!value) {
          custom.value = this.settings[`${this.settings.provider}${kind}Model`];
          return;
        }
        await this.save({ [`${this.settings.provider}${kind}Model`]: value });
      };
    }
    this.$('refreshConnection').onclick = () => this.refresh(true);
    this.$('login').onclick = async () => {
      const button = this.$('login');
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'login' });
        this.$('accountMessage').textContent = response.ok
          ? `${response.message}${response.command ? ` ${response.command}` : ''}` : response.error;
      } catch (err) { this.$('accountMessage').textContent = err.message; }
      finally { button.disabled = false; }
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const relevant = Object.entries(changes).filter(([key, value]) =>
        (key === 'provider' || /(?:Model|Connection)$/.test(key)) && this.settings[key] !== value.newValue);
      if (!relevant.length) return;
      for (const [key, value] of relevant) this.settings[key] = value.newValue ?? globalThis.CLAUDELY_DEFAULTS[key];
      this.onProvider();
      this.render();
      this.refresh();
    });
    this.render();
    await this.refresh();
  }

  render(models = []) {
    const p = this.settings.provider;
    this.$('provider').value = p;
    const connection = this.$('connection');
    connection.replaceChildren(new Option('Use existing connection', 'auto'), new Option('Local CLI login', 'local'));
    if (p !== 'opencode') connection.add(new Option('Connected local proxy', 'proxy'));
    connection.value = this.settings[`${p}Connection`];
    for (const kind of ['Check', 'Rewrite']) {
      const select = this.$(`${kind.toLowerCase()}Model`);
      const current = this.settings[`${p}${kind}Model`];
      const choices = [...new Set([current, ...models].filter(Boolean))];
      select.replaceChildren(...choices.map((m) => new Option(m, m)), new Option('Custom model…', '__custom'));
      select.value = current;
      const custom = this.$(`${kind.toLowerCase()}CustomModel`);
      custom.hidden = true;
      custom.value = current;
    }
  }

  async refresh(force = false) {
    const generation = ++this.generation;
    const p = this.settings.provider;
    this.$('accountMessage').textContent = '';
    this.$('modelMessage').textContent = 'Loading model choices…';
    this.$('accountStatus').textContent = 'Checking local connection…';
    this.$('led').className = 'led';
    this.$('refreshConnection').disabled = true;
    this.$('login').disabled = true;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'status', refresh: force });
      if (generation !== this.generation) return;
      this.status = status;
      if (!status.connected) throw new Error(status.error || 'Local host not connected. Run ./host/install.sh, then reload the extension.');
      const info = status.info.providers[p];
      // Older installed hosts explain how to upgrade instead of pretending ready.
      if (!info || !('authenticated' in info)) throw new Error('Update the local host with ./host/install.sh, then reload the extension.');
      const connection = this.settings[`${p}Connection`];
      const proxy = connection === 'proxy' || (connection === 'auto' && !info.authenticated && info.proxyAvailable);
      const ready = info.available && (proxy ? info.proxyAvailable : info.authenticated);
      this.$('led').className = `led ${ready ? 'ok' : 'bad'}`;
      this.$('accountStatus').textContent = !info.available ? `${globalThis.CLAUDELY_PROVIDER_NAMES[p]} CLI not installed`
        : proxy ? (info.proxyAvailable ? 'Using connected local proxy' : 'Local proxy not configured') : info.account;
      this.$('login').disabled = !info.available;
      this.$('login').textContent = proxy && connection === 'proxy' ? 'Connect proxy account' : ready ? 'Manage login' : 'Sign in';
      const result = await chrome.runtime.sendMessage({ type: 'models' });
      if (generation !== this.generation) return;
      if (!result.ok) throw new Error(result.error);
      this.render(result.models);
      this.$('modelMessage').textContent = p === 'opencode' ? 'Models from your local OpenCode configuration.' : 'Choose a model or enter a custom model ID.';
    } catch (err) {
      if (generation !== this.generation) return;
      if (!this.status?.connected) {
        this.$('led').className = 'led bad';
        this.$('accountStatus').textContent = 'Local host not connected';
      }
      this.$('modelMessage').textContent = err.message;
    } finally {
      if (generation === this.generation) this.$('refreshConnection').disabled = false;
    }
  }
};
globalThis.CLAUDELY_PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
