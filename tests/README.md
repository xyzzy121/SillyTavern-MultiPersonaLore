# Browser integration tests

`browser.mjs` runs the extension inside a real SillyTavern browser client. It uses native persona commands, the native persona lore dialog, native backup/restore, and the actual World Info scanner. No LLM connection or generation request is needed.

**Use a separate server and disposable data directory.** The harness creates and deletes personas, creates a group and chats, writes and deletes fixture lorebooks, and changes global World Info settings. It intentionally leaves the disposable user data in place for inspection. Never point it at your normal user data.

## Setup

1. Start a separate SillyTavern 1.19.0 server on port 8023 with its `--dataRoot` pointing at an empty disposable directory. Keep the normal server and its data separate.
2. Complete or disable the initial welcome screen for the disposable user. The default character supplied by SillyTavern must be available.
3. Copy this extension and `SillyTavern-MultiChatLore` into `<disposable-data>/default-user/extensions/`, with those exact folder names. Both must be enabled. The harness checks their listener interoperability in both activation orders.
4. Install Playwright outside this extension, and provide an installed Chromium browser or let Playwright use its managed browser.

Example in PowerShell:

```powershell
$env:ST_URL = 'http://127.0.0.1:8023'
$env:ST_TEST_DATA = 'C:\path\to\disposable-data'
$env:ST_PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright\index.mjs'
$env:ST_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:ST_TEST_OUTPUT = 'C:\path\to\browser-results'
node tests/browser.mjs
```

`ST_URL` defaults to `http://127.0.0.1:8023` and must use a loopback host. `ST_TEST_DATA` is the server's data root, containing `default-user/settings.json`; it is required for persisted-settings checks. `ST_PLAYWRIGHT_MODULE` is also required. `ST_BROWSER` is optional. Without `ST_TEST_OUTPUT`, results go into the operating system's temporary directory under `sillytavern-multi-persona-lore-tests`.

## Coverage and results

The 24 cases cover manifest loading; a late native template after a switch between personas with identical names; three-book binding and native primary compatibility; real keyword, disabled-entry, unbound-book and token-budget behavior; disk persistence and reload; persona, chat and group scope; search, focus and mobile overflow; primary promotion and the ordinary editor shortcut; native long press; live persona rename; native primary updates; duplication and backup/restore; overlap with global and character lore; MultiChatLore listener ordering; disable/reactivate cleanup; stale dialogs; delayed scans during disable, persona or chat switches, and descriptor replacement; missing books; and clearing bindings.

Each case prints `PASS`. The script exits nonzero on the first failed assertion and writes `results.json`, desktop/mobile screenshots, and a failure screenshot plus visible page text when relevant. Fixture names contain a timestamp, so reruns do not collide. Use fresh disposable data for a clean acceptance run. The server's production installation, source files, normal settings and normal data are not changed by this harness.
