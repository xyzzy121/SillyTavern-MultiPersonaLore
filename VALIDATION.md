# Validation

Validated on **November 16, 2026 (America/New_York)** against SillyTavern **1.19.0**, local staging commit `ad29cbda6`, using Node.js **26.2.0** and headless Microsoft Edge **157.0.4341.60**.

## Results

- JavaScript syntax checks for `index.js`, `lore.js`, and `tests/browser.mjs`: passed.
- Node unit suite: **20 passed, 0 failed**.
- Fresh browser acceptance run: **24 passed, 0 failed**, process exit **0**, and **0 uncaught page errors**.
- Desktop popup and mobile layout visually inspected at **1365 × 1000** and **390 × 844**.

Machine-readable browser results are in [docs/browser-results.json](docs/browser-results.json). Screenshots: [desktop](docs/persona-lore-desktop.png) and [mobile](docs/persona-lore-mobile.png).

## Browser coverage

The reproducible [browser harness](tests/browser.mjs) loads the extension through SillyTavern's real extension loader and exercises:

- Three-book binding, primary-string compatibility, primary promotion, clearing, searchable selection, keyboard focus, mobile layout, editor shortcuts, long press, and live persona renaming.
- Real `getSortedEntries()` and `getWorldInfoPrompt()` calls, including keyword activation, disabled entries, unbound-book exclusion, and a native token-budget cap.
- Settings written to disk and retained after a full browser reload.
- Persona isolation across individual chats and group chats, with unchanged global selections during persona switching.
- Native persona duplication, backup, deletion, and restore, including independent copied bindings.
- Native primary-book commands retaining additional bindings.
- Global and character overlap, plus the actual MultiChatLore extension in both activation orders with chat precedence and no duplicate entries.
- Idempotent reactivation, restoration of the native picker on disable, and stale-dialog protection.
- A delayed first popup template after switching between different personas with identical display names.
- Delayed lorebook loads during disable, persona switching, chat switching, and descriptor replacement.
- Missing-book visibility and removal while valid lore continues to load.

## Unit coverage

The Node suite covers descriptor persistence and isolation, active-primary overrides, duplicate-persona copying, primary promotion, malformed imported data, source precedence, UID deduplication, missing and failed loads, bounded concurrency, atomic cancellation, cache safety, and fresh data on subsequent scans.

## Method and limits

Tests used separate localhost servers and disposable user data. No requests were sent to an LLM provider. Persona and World Info operations used the actual host APIs, native commands, dialogs, and scanner. The prompt-builder check initializes the native Author's Note prompt just as the generation flow does.

The browser touch test dispatches touch events into SillyTavern's real long-press handler; it does not represent a physical mobile-device test. Other third-party extensions were not part of the browser run, apart from MultiChatLore. Compatibility with single-book consumers relies on preserving SillyTavern's native primary string.

SillyTavern's settings save is debounced and may report failures through host notifications. The extension therefore says “Selection updated,” rather than claiming that every click has already reached disk. Successful disk persistence was verified separately during the acceptance run.

The extension's minimum supported client version is **1.19.0**. Older versions were not validated.

See [tests/README.md](tests/README.md) to reproduce the browser run with your own disposable server and Playwright installation.
