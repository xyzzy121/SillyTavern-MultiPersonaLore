import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run only against a disposable SillyTavern user. See tests/README.md.
const url = process.env.ST_URL ?? 'http://127.0.0.1:8023';
const dataRoot = process.env.ST_TEST_DATA;
assert.ok(dataRoot, 'ST_TEST_DATA must name the disposable server data root');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Integration tests require a loopback server');
const output = path.resolve(process.env.ST_TEST_OUTPUT ?? path.join(os.tmpdir(), 'sillytavern-multi-persona-lore-tests'));
const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
await readFile(settingsPath, 'utf8');
await mkdir(output, { recursive: true });
const playwrightModule = process.env.ST_PLAYWRIGHT_MODULE;
assert.ok(playwrightModule, 'ST_PLAYWRIGHT_MODULE must name Playwright index.mjs or index.js');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const browser = await chromium.launch({
    executablePath: process.env.ST_BROWSER || undefined,
    headless: true,
});
const page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(20000);
const extension = 'SillyTavern-MultiPersonaLore';
const stamp = `${Date.now()}`;
const names = {
    setting: `MPL ${stamp} Campaign Setting`,
    cast: `MPL ${stamp} Character Cast`,
    rules: `MPL ${stamp} House Rules`,
    global: `MPL ${stamp} Global Notes`,
    unbound: `MPL ${stamp} Unbound Lore`,
};
const errors = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
const results = { started: new Date().toISOString(), url, browser: browser.version(), cases: [], errors };
let personaA;
let personaB;

async function run(name, callback) {
    const started = Date.now();
    try {
        await callback();
        results.cases.push({ name, passed: true, durationMs: Date.now() - started });
        console.log('PASS', name);
    } catch (error) {
        results.cases.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack });
        throw error;
    }
}
async function ready() {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'), null, { timeout: 120000 });
}
async function slash(command) {
    return page.evaluate(async command => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        const result = await executeSlashCommandsWithOptions(command, { handleParserErrors: false });
        if (result?.isError) throw new Error(result.error ?? 'Slash command failed');
        return result?.pipe;
    }, command);
}
async function selectPersona(avatar) {
    await page.evaluate(async avatar => (await import('/scripts/personas.js')).setUserAvatar(avatar, { toastPersonaNameChange: false }), avatar);
    await page.waitForFunction(async avatar => (await import('/scripts/personas.js')).user_avatar === avatar, avatar);
}
async function descriptor(avatar = personaA) {
    return page.evaluate(avatar => structuredClone(SillyTavern.getContext().powerUserSettings.persona_descriptions[avatar]), avatar);
}
async function metadata() {
    return page.evaluate(() => structuredClone(SillyTavern.getContext().chatMetadata));
}
async function entries() {
    return page.evaluate(async () => (await (await import('/scripts/world-info.js')).getSortedEntries()).map(e => ({ world: e.world, uid: e.uid, hash: e.hash })));
}
async function fixtureWorlds() {
    return (await entries()).filter(e => e.world.startsWith(`MPL ${stamp} `)).map(e => e.world);
}
async function prompt(text = 'nothing matches') {
    return page.evaluate(async text => {
        (await import('/scripts/authors-note.js')).setFloatingPrompt();
        return (await (await import('/scripts/world-info.js')).getWorldInfoPrompt([text], 8192, true)).worldInfoString;
    }, text);
}
async function openPicker() {
    await page.evaluate(() => { $('#persona_lore_button').trigger($.Event('click', { shiftKey: true, altKey: false })); });
    await page.locator('.mpl-picker').waitFor({ state: 'visible' });
}
async function closePicker() {
    const dialog = page.locator('dialog[open]').filter({ has: page.locator('.mpl-picker') });
    await dialog.locator('.popup-button-ok').click();
    await page.locator('.mpl-picker').waitFor({ state: 'detached' });
}
function row(name) {
    return page.locator('.mpl-row').filter({ has: page.locator(`.mpl-book-label input[value=${JSON.stringify(name)}]`) });
}
async function selectionUpdated() {
    await page.waitForFunction(() => document.querySelector('.mpl-status')?.textContent === 'Selection updated.');
}
async function bind(name, checked = true) {
    const input = page.locator(`.mpl-book-label input[value=${JSON.stringify(name)}]`);
    if (await input.isChecked() !== checked) {
        await input.click();
        await selectionUpdated();
    }
}
async function makePrimary(name) {
    await row(name).locator('.mpl-primary').click();
    await selectionUpdated();
}
async function openChat(name) {
    await page.evaluate(name => SillyTavern.getContext().openCharacterChat(name), name);
    await page.waitForFunction(name => SillyTavern.getContext().getCurrentChatId() === name, name);
}
async function assertSaved(predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
        if (predicate(saved)) return saved;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Settings did not reach expected persisted state');
}
async function lifecycle(order) {
    await page.evaluate(async order => {
        const mpl = await import('/scripts/extensions/third-party/SillyTavern-MultiPersonaLore/index.js');
        const mcl = await import('/scripts/extensions/third-party/SillyTavern-MultiChatLore/index.js');
        mpl.onDisable();
        mcl.onDisable();
        for (const item of order) await (item === 'persona' ? mpl : mcl).onActivate();
    }, order);
}
async function heldRequest(pattern, matches, start, change) {
    let release;
    let seen;
    let timer;
    let handled;
    const released = new Promise(resolve => { release = resolve; });
    const requestSeen = new Promise(resolve => { seen = resolve; });
    const requestHandled = new Promise(resolve => { handled = resolve; });
    let routeError;
    const handler = async route => {
        if (!matches(route.request())) return route.continue();
        seen();
        await released;
        try { await route.continue(); } catch (error) { routeError = error; }
        handled();
    };
    await page.route(pattern, handler);
    try {
        await start();
        await Promise.race([requestSeen, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`No delayed request: ${pattern}`)), 15000);
        })]);
        clearTimeout(timer);
        await Promise.race([change(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`State change blocked while request held: ${pattern}`)), 15000);
        })]);
        clearTimeout(timer);
        release();
        await requestHandled;
        if (routeError) throw routeError;
    } finally {
        clearTimeout(timer);
        release();
        await page.unroute(pattern, handler);
    }
}
async function delayedScanDuring(change) {
    await heldRequest('**/api/worldinfo/get', request => request.postDataJSON()?.name === names.cast, async () => {
        await page.evaluate(async name => {
            const wi = await import('/scripts/world-info.js');
            wi.worldInfoCache.delete(name);
            window.__mplPendingScan = wi.getSortedEntries();
        }, names.cast);
    }, change);
    const worlds = await page.evaluate(async () => (await window.__mplPendingScan).map(e => e.world));
    assert.equal(worlds.includes(names.cast), false);
    assert.equal(worlds.includes(names.rules), false);
}

try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await ready();
    await run('extension loads from native manifest and lifecycle hook', async () => {
        assert.equal(await page.evaluate(async extension => (await import('/scripts/extensions.js')).extensionNames.includes(`third-party/${extension}`), extension), true);
    });

    await page.evaluate(async names => {
        const wi = await import('/scripts/world-info.js');
        for (const [index, name] of Object.values(names).entries()) {
            const entry = { uid: 0, ...structuredClone(wi.newWorldInfoEntryTemplate), key: ['mpl-fixture-trigger'],
                constant: index !== 1, disable: index === 2, content: `MPL_CONTENT_${index}`, comment: name,
                order: 100 + index, probability: 100, useProbability: false };
            await wi.saveWorldInfo(name, { entries: { 0: entry } }, true);
        }
        await wi.updateWorldInfoList();
        wi.updateWorldInfoSettings({ ...wi.getWorldInfoSettings(), world_info_budget: 100, world_info_budget_cap: 0 }, [names.global]);
    }, names);
    personaA = await slash(`/persona-create name="MPL Persona A ${stamp}" description="Disposable browser test persona A"`);
    personaB = await slash(`/persona-create name="MPL Persona B ${stamp}" description="Disposable browser test persona B" select=false`);
    assert.ok(personaA && personaB && personaA !== personaB);
    await selectPersona(personaA);
    await page.evaluate(async () => (await import('/script.js')).selectCharacterById(0));
    if (await page.locator('dialog[open] .popup-button-cancel').count()) await page.locator('dialog[open] .popup-button-cancel').last().click();
    await page.waitForFunction(() => Boolean(SillyTavern.getContext().getCurrentChatId()));
    await openChat(`MPL ${stamp} Chat A`);
    await selectPersona(personaA);
    await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        ctx.characters[ctx.characterId].data.extensions.world = '';
        delete ctx.chatMetadata.world_info;
        delete ctx.chatMetadata.multi_chat_lorebooks;
        await ctx.saveMetadata();
    });

    await run('a late native picker cannot edit the persona selected after its template request', async () => {
        // Identical visible names make this depend on the opener identity, not its label.
        await slash(`/persona-update persona="${personaB}" name="MPL Persona A ${stamp}"`);
        await heldRequest('**/scripts/templates/personaLorebook.html', () => true,
            () => page.evaluate(() => { $('#persona_lore_button').trigger($.Event('click', { shiftKey: true, altKey: false })); }),
            () => selectPersona(personaB));
        await page.locator('.mpl-picker').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.mpl-clear').isDisabled(), true);
        assert.equal(await page.locator('.mpl-book-label input:enabled').count(), 0);
        assert.equal((await descriptor(personaB)).multi_persona_lorebooks, undefined);
        await closePicker();
        await slash(`/persona-update name="MPL Persona B ${stamp}"`);
        await selectPersona(personaA);
    });

    await run('native persona popup binds three books with one native primary', async () => {
        await openPicker();
        assert.equal(await page.locator('.persona_world_info_selector').isVisible(), false);
        await bind(names.setting);
        await bind(names.cast);
        assert.equal(await page.evaluate(() => document.activeElement?.value), names.cast);
        await bind(names.rules);
        const data = await descriptor();
        assert.equal(data.lorebook, names.setting);
        assert.deepEqual(data.multi_persona_lorebooks, { version: 1, books: [names.cast, names.rules] });
        assert.equal(await page.locator('.mpl-selection-count').textContent(), '3 lorebooks bound');
        await page.evaluate(() => toastr.remove());
        await page.locator('dialog[open]').filter({ has: page.locator('.mpl-picker') }).screenshot({ path: path.join(output, 'desktop.png') });
        await closePicker();
    });

    await run('real World Info scan respects keywords, disabled entries, unbound books and budget', async () => {
        const worlds = await fixtureWorlds();
        assert.deepEqual(worlds, [names.rules, names.cast, names.setting, names.global]);
        assert.equal(new Set(worlds).size, worlds.length);
        const noMatch = await prompt();
        assert.match(noMatch, /MPL_CONTENT_0/);
        assert.doesNotMatch(noMatch, /MPL_CONTENT_1/);
        assert.doesNotMatch(noMatch, /MPL_CONTENT_2/);
        assert.doesNotMatch(noMatch, /MPL_CONTENT_4/);
        const matching = await prompt('mpl-fixture-trigger');
        assert.match(matching, /MPL_CONTENT_1/);
        assert.doesNotMatch(matching, /MPL_CONTENT_2/);
        const budget = await page.evaluate(async () => {
            const wi = await import('/scripts/world-info.js');
            const before = wi.getWorldInfoSettings();
            try {
                wi.updateWorldInfoSettings({ ...before, world_info_budget_cap: 1 });
                return (await wi.getWorldInfoPrompt(['mpl-fixture-trigger'], 8192, true)).worldInfoString;
            } finally { wi.updateWorldInfoSettings(before); }
        });
        assert.doesNotMatch(budget, /MPL_CONTENT_/);
    });

    await run('settings persist on disk and bindings survive page reload', async () => {
        const saved = await assertSaved(s => s.power_user?.persona_descriptions?.[personaA]?.multi_persona_lorebooks?.books?.length === 2);
        assert.deepEqual(saved.power_user.persona_descriptions[personaA].multi_persona_lorebooks.books, [names.cast, names.rules]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready();
        await page.evaluate(async () => (await import('/script.js')).selectCharacterById(0));
        await page.waitForFunction(() => Boolean(SillyTavern.getContext().getCurrentChatId()));
        await selectPersona(personaA);
        assert.deepEqual((await descriptor()).multi_persona_lorebooks.books, [names.cast, names.rules]);
        assert.deepEqual(await fixtureWorlds(), [names.rules, names.cast, names.setting, names.global]);
    });

    await run('switching persona isolates extras; switching chat retains persona scope', async () => {
        await selectPersona(personaB);
        assert.equal((await descriptor(personaB)).multi_persona_lorebooks, undefined);
        assert.deepEqual(await fixtureWorlds(), [names.global]);
        await selectPersona(personaA);
        await openChat(`MPL ${stamp} Chat B`);
        await selectPersona(personaA);
        assert.deepEqual(await fixtureWorlds(), [names.rules, names.cast, names.setting, names.global]);
        assert.deepEqual(await page.evaluate(async () => (await import('/scripts/world-info.js')).selected_world_info), [names.global]);
        await openChat(`MPL ${stamp} Chat A`);
        await selectPersona(personaA);
    });

    await run('search, primary changes, keyboard focus, count and mobile layout', async () => {
        await openPicker();
        await page.locator('.mpl-search').fill(names.rules);
        assert.equal(await page.locator('.mpl-row:visible').count(), 1);
        await makePrimary(names.rules);
        assert.equal((await descriptor()).lorebook, names.rules);
        await page.locator('.mpl-search').fill('');
        await bind(names.cast, false);
        assert.equal(await page.evaluate(() => document.activeElement?.value), names.cast);
        assert.deepEqual((await descriptor()).multi_persona_lorebooks.books, [names.setting]);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('.mpl-picker').evaluate(e => e.scrollWidth > e.clientWidth), false);
        await page.screenshot({ path: path.join(output, 'mobile.png') });
        await bind(names.cast);
        await makePrimary(names.setting);
        await closePicker();
        await page.setViewportSize({ width: 1365, height: 1000 });
    });

    await run('removing the primary promotes the next book and ordinary click opens its editor', async () => {
        const next = (await descriptor()).multi_persona_lorebooks.books[0];
        await openPicker();
        await bind(names.setting, false);
        assert.equal((await descriptor()).lorebook, next);
        assert.equal(await slash('/getpersonabook'), next);
        await closePicker();
        await page.evaluate(() => $('#persona_lore_button').trigger($.Event('click', { shiftKey: false, altKey: false })));
        await page.waitForFunction(name => $('#world_editor_select option:selected').text() === name, next);
        assert.equal(await page.locator('.mpl-picker').count(), 0);
        await openPicker();
        await bind(names.setting);
        await makePrimary(names.setting);
        await closePicker();
    });

    await run('native long press opens an editable persona picker', async () => {
        await page.evaluate(() => {
            const target = document.querySelector('#persona_lore_button');
            const rect = target.getBoundingClientRect();
            window.__mplTouch = new Touch({ identifier: 1, target, clientX: rect.x + 1, clientY: rect.y + 1,
                pageX: rect.x + 1, pageY: rect.y + 1 });
            target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true,
                touches: [window.__mplTouch], targetTouches: [window.__mplTouch], changedTouches: [window.__mplTouch] }));
        });
        await page.locator('.mpl-picker').waitFor({ state: 'visible' });
        await page.evaluate(() => document.querySelector('#persona_lore_button').dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [window.__mplTouch],
        })));
        assert.equal(await page.locator('.mpl-clear').isDisabled(), false);
        assert.equal(await page.locator('.mpl-selection-count').textContent(), '3 lorebooks bound');
        await closePicker();
    });

    await run('a persona renamed while the picker is open updates its heading', async () => {
        await openPicker();
        const renamed = `MPL Persona Renamed ${stamp}`;
        await slash(`/persona-update name="${renamed}"`);
        await page.waitForFunction(name => document.querySelector('.persona_world .persona_name')?.textContent === name, renamed);
        assert.equal(await page.locator('.mpl-clear').isDisabled(), false);
        await slash(`/persona-update name="MPL Persona A ${stamp}"`);
        await closePicker();
    });

    await run('native getpersonabook and persona-update keep single-primary compatibility', async () => {
        assert.equal(await slash('/getpersonabook'), names.setting);
        await slash(`/persona-update lorebook="${names.cast}"`);
        assert.equal(await slash('/getpersonabook'), names.cast);
        assert.equal((await descriptor()).lorebook, names.cast);
        const worlds = await fixtureWorlds();
        assert.equal(worlds.filter(name => name === names.cast).length, 1);
        assert.ok(worlds.includes(names.rules));
        await openPicker();
        await bind(names.setting);
        await makePrimary(names.setting);
        await closePicker();
    });

    await run('native persona duplication deep-copies additional lorebook bindings', async () => {
        const original = await descriptor();
        const duplicate = await slash(`/persona-duplicate persona="${personaA}" select=true`);
        assert.ok(duplicate && duplicate !== personaA);
        assert.deepEqual((await descriptor(duplicate)).multi_persona_lorebooks, original.multi_persona_lorebooks);
        await openPicker();
        await bind(names.cast, false);
        await closePicker();
        assert.deepEqual((await descriptor()).multi_persona_lorebooks, original.multi_persona_lorebooks);
        await selectPersona(personaA);
        assert.equal(await slash(`/persona-delete persona="${duplicate}" silent=true`), 'true');
        assert.equal(await descriptor(duplicate), undefined);
    });

    await run('native persona backup, deletion and restore preserve additional books', async () => {
        const original = await descriptor();
        const downloadPromise = page.waitForEvent('download');
        await page.evaluate(() => $('#personas_backup').trigger('click'));
        const download = await downloadPromise;
        const backup = await readFile(await download.path());
        assert.deepEqual(JSON.parse(backup).persona_descriptions[personaA].multi_persona_lorebooks, original.multi_persona_lorebooks);
        await selectPersona(personaB);
        assert.equal(await slash(`/persona-delete persona="${personaA}" silent=true`), 'true');
        assert.equal(await descriptor(), undefined);
        await page.locator('#personas_restore_input').setInputFiles({ name: 'mpl-personas-backup.json', mimeType: 'application/json', buffer: backup });
        await page.waitForFunction(avatar => Boolean(SillyTavern.getContext().powerUserSettings.persona_descriptions[avatar]), personaA);
        assert.deepEqual((await descriptor()).multi_persona_lorebooks, original.multi_persona_lorebooks);
        await selectPersona(personaA);
    });

    await run('global and character overlap scan once with native source priority', async () => {
        await page.evaluate(async ({ names, personaA }) => {
            const ctx = SillyTavern.getContext();
            ctx.characters[ctx.characterId].data.extensions.world = names.cast;
            const data = ctx.powerUserSettings.persona_descriptions[personaA];
            data.multi_persona_lorebooks.books.push(names.global);
        }, { names, personaA });
        const worlds = await fixtureWorlds();
        assert.equal(worlds.filter(name => name === names.cast).length, 1);
        assert.equal(worlds.filter(name => name === names.global).length, 1);
        await page.evaluate(() => { const ctx = SillyTavern.getContext(); ctx.characters[ctx.characterId].data.extensions.world = ''; });
    });

    await run('MultiChatLore coexistence deduplicates with chat priority in both listener orders', async () => {
        await page.evaluate(({ names }) => {
            const ctx = SillyTavern.getContext();
            ctx.chatMetadata.world_info = names.cast;
            ctx.chatMetadata.multi_chat_lorebooks = { version: 1, books: [names.rules] };
        }, { names });
        for (const order of [['persona', 'chat'], ['chat', 'persona']]) {
            await lifecycle(order);
            const worlds = await fixtureWorlds();
            assert.equal(worlds.filter(name => name === names.rules).length, 1, order.join(','));
            assert.equal(worlds.filter(name => name === names.cast).length, 1, order.join(','));
            assert.deepEqual(worlds.slice(0, 2), [names.rules, names.cast]);
            assert.ok(worlds.includes(names.setting));
        }
        await page.evaluate(async () => {
            const ctx = SillyTavern.getContext();
            delete ctx.chatMetadata.world_info;
            delete ctx.chatMetadata.multi_chat_lorebooks;
            await ctx.saveMetadata();
        });
    });

    await run('disable restores native picker and reactivation installs one picker and listener', async () => {
        await openPicker();
        await page.evaluate(async () => (await import('/scripts/extensions/third-party/SillyTavern-MultiPersonaLore/index.js')).onDisable());
        assert.equal(await page.locator('.mpl-picker').count(), 0);
        assert.equal(await page.locator('.persona_world_info_selector').isVisible(), true);
        assert.deepEqual(await fixtureWorlds(), [names.setting, names.global]);
        await page.evaluate(async () => {
            const ext = await import('/scripts/extensions/third-party/SillyTavern-MultiPersonaLore/index.js');
            ext.onActivate(); ext.onActivate();
        });
        await page.locator('.mpl-picker').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.mpl-picker').count(), 1);
        const worlds = await fixtureWorlds();
        assert.equal(worlds.filter(name => name === names.cast).length, 1);
        assert.equal(worlds.filter(name => name === names.rules).length, 1);
        await closePicker();
    });

    await run('an open picker becomes inert after the active persona changes', async () => {
        await openPicker();
        await selectPersona(personaB);
        assert.equal(await page.locator('.mpl-clear').isDisabled(), true);
        assert.equal(await page.locator('.mpl-book-label input:enabled').count(), 0);
        assert.match(await page.locator('.mpl-status').textContent(), /changed|reopen/i);
        assert.equal((await descriptor(personaB)).multi_persona_lorebooks, undefined);
        await closePicker();
        await selectPersona(personaA);
    });

    await run('pending scan does not inject extra books after extension disable', async () => {
        try {
            await delayedScanDuring(() => page.evaluate(async () => (await import('/scripts/extensions/third-party/SillyTavern-MultiPersonaLore/index.js')).onDisable()));
        } finally {
            await page.evaluate(async () => (await import('/scripts/extensions/third-party/SillyTavern-MultiPersonaLore/index.js')).onActivate());
        }
    });

    await run('pending scan does not inject old extras after a persona switch', async () => {
        await delayedScanDuring(() => selectPersona(personaB));
        await selectPersona(personaA);
    });

    await run('pending scan does not inject old extras after a chat switch', async () => {
        const next = `MPL ${stamp} Pending Chat`;
        await delayedScanDuring(async () => {
            await page.evaluate(name => {
                window.__mplPendingChatSwitch = SillyTavern.getContext().openCharacterChat(name);
            }, next);
            await page.waitForFunction(name => SillyTavern.getContext().getCurrentChatId() === name, next);
        });
        await page.evaluate(() => window.__mplPendingChatSwitch);
        await selectPersona(personaA);
    });

    await run('pending scan does not inject extras from a replaced persona descriptor', async () => {
        await delayedScanDuring(() => page.evaluate(avatar => {
            const user = SillyTavern.getContext().powerUserSettings;
            user.persona_descriptions[avatar] = structuredClone(user.persona_descriptions[avatar]);
        }, personaA));
    });

    await run('group chats use the active persona and remain isolated when persona changes', async () => {
        const groupId = await page.evaluate(async stamp => {
            const ctx = SillyTavern.getContext();
            const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ name: `MPL Test Group ${stamp}`, members: [ctx.characters[0].avatar] }) });
            assertResponse(response);
            const group = await response.json();
            const api = await import('/scripts/group-chats.js');
            await api.getGroups();
            await api.openGroupById(group.id);
            return group.id;
            function assertResponse(response) { if (!response.ok) throw new Error(`Create group: HTTP ${response.status}`); }
        }, stamp);
        assert.ok(groupId);
        await selectPersona(personaA);
        assert.ok((await fixtureWorlds()).includes(names.cast));
        await selectPersona(personaB);
        assert.deepEqual(await fixtureWorlds(), [names.global]);
        await selectPersona(personaA);
        assert.ok((await fixtureWorlds()).includes(names.cast));
    });

    await run('missing extra stays bound and visible while valid lore continues scanning', async () => {
        await page.evaluate(async name => (await import('/scripts/world-info.js')).deleteWorldInfo(name), names.cast);
        await openPicker();
        await row(names.cast).locator('.mpl-missing').waitFor({ state: 'visible' });
        assert.ok((await descriptor()).multi_persona_lorebooks.books.includes(names.cast));
        assert.equal((await fixtureWorlds()).includes(names.cast), false);
        assert.ok((await fixtureWorlds()).includes(names.setting));
        await bind(names.cast, false);
        await closePicker();
    });

    await run('clear removes native primary and extras without changing another persona', async () => {
        const other = await descriptor(personaB);
        await openPicker();
        await page.locator('.mpl-clear').click();
        await selectionUpdated();
        const data = await descriptor();
        assert.equal(data.lorebook, '');
        assert.equal(data.multi_persona_lorebooks, undefined);
        assert.equal(await slash('/getpersonabook'), '');
        assert.deepEqual(await descriptor(personaB), other);
        assert.deepEqual(await fixtureWorlds(), [names.global]);
        await closePicker();
        await assertSaved(s => s.power_user?.persona_descriptions?.[personaA]?.lorebook === ''
            && s.power_user.persona_descriptions[personaA].multi_persona_lorebooks === undefined);
    });
    assert.deepEqual(errors, [], 'Unexpected browser page errors');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await writeFile(path.join(output, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
} finally {
    results.finished = new Date().toISOString();
    await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    await browser.close();
    console.log(`Results: ${path.join(output, 'results.json')}`);
}
