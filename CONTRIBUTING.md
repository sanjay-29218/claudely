# Contributing

Claudely is a plain JavaScript Manifest V3 extension with a Node.js native
messaging host. No build step or npm dependencies are required.

## Local setup

1. Install Node.js 22 or later and at least one supported CLI (`claude`,
   `codex`, or `opencode` v2+), then connect your account through that CLI.
2. Clone the repository and run `./host/install.sh`.
3. Load `extension/` as an unpacked extension in your Chromium browser.
4. Open Claudely's Settings and test your selected provider.

After changing extension code, reload it from your browser's extensions page.
After changing the native host, reload the extension to restart the connection.
Re-run the installer after moving the checkout or changing CLI locations.

## Checks

```sh
npm run check
npm test
```

These checks use fixture CLIs, require no account credentials, and make no
model requests. GitHub Actions runs them on macOS and Linux with Node 22 and 24.

The optional `tools/host-smoke.mjs` and `tools/editor-tests.mjs` checks use
real model requests and your account quota; see the README before running them.
Browser automation tools use Node 22's built-in WebSocket client.

For keyboard isolation regressions, start Chrome with
`--remote-debugging-port=9333` (or use `tools/test-browser.sh`), then run
`npm run test:browser`. These tests open an isolated browser context, inject
the actual content script with fixture model responses, and make no provider
requests. They cover host-page capture listeners, normal typing and selection,
IME confirmation, keyboard submission and dismissal, suggestion cards, and
focus return at desktop and narrow widths, including a strict page CSP.

## Changes

Keep pull requests focused, describe the behavior you changed, and include
the checks you ran. Report browser and provider versions when filing a bug.
Use sample text in reports, and remove credentials and personal writing from
screenshots and logs.

Credentials, CLI account files, and `tools/extension-key.pem` belong outside
Git. The extension's public key in the manifest and `tools/extension-key.json`
is intentionally shared so installations use a consistent extension ID.
