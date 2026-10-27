# Claudely

[![CI](https://github.com/sanjay-29218/claudely/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjay-29218/claudely/actions/workflows/ci.yml)

A Grammarly-style writing assistant for Chromium browsers that runs on your
own **Claude Code**, **Codex**, or **OpenCode** accounts. The extension uses
the `claude`, `codex`, or `opencode` CLI already installed on your machine.
Account credentials stay with the CLI; Claudely never stores them in the browser.

- **Underlines as you type** in textareas and rich editors. Red is
  correctness (spelling, grammar, punctuation), blue is clarity/style. Tested
  end to end (check, accept, accept all, editor state stays in sync) with
  Lexical, ProseMirror/Tiptap, Quill, Slate, Draft.js, TinyMCE, CKEditor 5,
  plain contenteditable and React-controlled textareas.
- **Hover or click an underline** to accept, dismiss, or add the word to your
  dictionary.
- **Panel** (click the badge in the corner of the field): see all suggestions,
  accept all, or rewrite the selection or whole text: Fix mistakes, Improve,
  Shorten, More formal, Friendlier, Simplify, Confident, or a custom
  instruction. Rewrites are shown as a word-level diff before replacing.
- **Quick fix** `Alt+Shift+G`: fix the selection (or whole field) in place.
  Undo with `Cmd/Ctrl+Z`.
- **Right-click** in any text field → Claudely → any rewrite. Shortcuts and
  the menu work in any editable field, including ones Claudely doesn't check
  automatically (single-line inputs, `spellcheck="false"` textareas).
- **Keyboard isolation:** typing or navigating inside Claudely's controls
  stays inside Claudely, so page shortcuts such as X's `j`/`k` do not fire.
  Escape closes the panel and returns focus to your writing field.

## Setup

Supported platforms: macOS and Linux with a Chromium browser.

Requirements: Node 22+, plus at least one of `claude`, `codex`, or
`opencode` (v2+) on your `PATH`, with an account connected locally.

```sh
git clone https://github.com/sanjay-29218/claudely.git
cd claudely
./host/install.sh
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load
unpacked**, and pick the `extension/` folder. The extension has a fixed ID
(`kkimlmldpojnilpclegbgecfimagfmlk`) so the installer can authorize it ahead
of time.

The installer registers the native host for Chrome, Chrome Beta/Canary,
Chromium, Brave, Edge, Vivaldi, Arc, Dia and Opera (whichever exist). Re-run
it if you move this folder or reinstall a CLI. `./host/uninstall.sh` removes
it.

Choose **Provider**, **Checking model**, and **Rewriting model** in the popup
or **Settings**, then press **Test connection** in Settings. Codex with
`gpt-6-luna` is the default; existing saved choices are preserved. Each provider
remembers its own models and connection. Model menus include custom model IDs;
OpenCode's choices come from `opencode models`.

**Use existing connection** reuses a local CLI login, or the connected local
proxy when there is no CLI login. You can explicitly choose **Local CLI login**
or **Connected local proxy** for Claude and Codex. The proxy option reuses the
existing loopback CLIProxyAPI setup at `127.0.0.1:8317`, reading its password
from `~/.config/t3-local-proxy/keys.json` in the native host only.

**Sign in / Manage login** opens the selected CLI's login flow in Terminal on
macOS. Finish the browser or terminal flow, then press **Refresh**. On Linux,
Claudely displays the command to run yourself (`claude auth login`, `codex login`,
or `opencode auth login`). It never logs you out automatically. A saved login
may still need renewed credentials or available quota; **Test connection** shows
the actual upstream error.

Tabs that were already open get Claudely injected on
install and update, so there's no need to reload them.

## How it works

```
page field ──content.js──▶ background.js ──native messaging──▶ host/claudely-host.mjs ──▶ claude -p / codex exec / opencode run
```

- `content.js` splits the field into paragraphs and sends only paragraphs it
  hasn't seen. Results are cached per paragraph, so editing one paragraph
  never re-checks the others, and accepting a fix shifts the remaining
  underlines without another round trip.
- `background.js` builds the prompts, asks for structured JSON (schema flags
  for Claude/Codex, schema instructions for OpenCode), caches results, and
  cancels checks for text you've already typed over.
- `host/claudely-host.mjs` runs the CLI with **all tools disabled**
  (`claude --tools ""`, and for Codex the shell, apps, browser, MCP and code
  mode features are turned off in a read-only sandbox). OpenCode runs a private
  server with a text-only agent and all tool permissions denied. Text from web pages
  is untrusted, so the model can only return text, never act.

Defaults: Codex is selected. Claude uses `haiku` for checking and `sonnet`
for rewrites; Codex uses `gpt-6-luna` (low effort for checks, medium for rewrites); OpenCode uses
`openai/gpt-6-luna` through its saved account. Expect
roughly 3–5 s per check with Claude and 5–9 s with Codex. Everything is
debounced and cached, so you only pay for paragraphs that changed.

## Turning it off

- Popup: global switch, per-site switch, and "check while I type".
- Fields marked `data-claudely="false"` or `data-gramm="false"`, textareas
  with `spellcheck="false"`, and code editors (CodeMirror, Monaco, Ace) are
  skipped. Single-line inputs are skipped unless enabled in Settings. (Rich
  editors often set `spellcheck="false"` just to hide the browser's
  squiggles, so it doesn't opt them out.)

## Privacy

Claudely sends the text it checks or rewrites to your selected provider through
its local CLI. The model provider's own data policies apply. Account credentials
stay in the CLI's credential store or the local proxy configuration; they are
not synced through the browser. Claudely preferences use browser sync storage,
and the personal dictionary stays in local extension storage.

No analytics or separate Claudely backend is included. The development signing
private key is excluded from this repository; the public extension key is shared
to keep the extension ID consistent.

## Development

There is no build step or npm dependency installation. Run the offline checks:

```sh
npm run check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

- `node --test tools/provider-tests.mjs`: provider routing, model catalogs,
  credential isolation, tool restrictions, and upstream error handling.
- `node tools/host-smoke.mjs [claude|codex|opencode] [auto|local|proxy] [model]`: drive the host over its stdio
  protocol.
- `tools/test-browser.sh`: launch a headless Chrome for Testing with the
  extension loaded (serve `tools/` on port 8765 for `playground.html`), then
  drive it with `node tools/cdp.mjs`. Its `xeval` command runs code in the
  content script's world, where `__claudelyDebug` exposes the field state.
- `node tools/editor-tests.mjs [name...]`: types known mistakes into real
  editors (local playground plus the public Lexical, ProseMirror, Slate,
  Draft.js, TinyMCE and CKEditor demos), accepts every suggestion, and checks
  the result and the editor's own model.
- `node tools/make-icons.mjs`: regenerate the icons.
- Host logs: `$TMPDIR/claudely-host/host.log`.

Limitations: canvas-based editors (Google Docs) aren't supported, and some
heavily custom editors may reject programmatic edits. Use Copy from the
rewrite panel there.
