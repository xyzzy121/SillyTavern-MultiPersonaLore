import { user_avatar, getOrCreatePersonaDescriptor } from '/scripts/personas.js';
import { METADATA_KEY, uniqueNames, getBindings, setBindings, copyExtraBindings, getChatIdentity, addPersonaLore } from './lore.js';

let controller;

/** SillyTavern 1.19+ extension lifecycle hooks. */
export function onActivate() {
    if (controller) return;
    const ctx = SillyTavern.getContext();
    if (!ctx.eventTypes.WORLDINFO_ENTRIES_LOADED || !ctx.eventTypes.PERSONA_CREATED
        || !ctx.getWorldInfoNames || !ctx.loadWorldInfo) {
        toastr.error('Multiple Persona Lorebooks requires SillyTavern 1.19.0 or newer.');
        return;
    }
    controller = createController();
}

export function onDisable() {
    controller?.dispose();
    controller = undefined;
}

function createController() {
    const panels = new Map();
    const listeners = [];
    const warnings = new Set();
    const context = () => SillyTavern.getContext();
    let disposed = false;
    let revision = 0;
    let opener;

    function descriptor(ctx = context(), avatar = user_avatar) {
        return ctx.powerUserSettings.persona_descriptions?.[avatar];
    }

    function bindings(ctx = context()) {
        return getBindings(descriptor(ctx), ctx.powerUserSettings.persona_description_lorebook);
    }

    function listen(type, handler, first = false) {
        if (!type) return;
        const source = context().eventSource;
        if (first) source.makeFirst(type, handler);
        else source.on(type, handler);
        listeners.push(() => source.removeListener(type, handler));
    }

    function updateButton() {
        const button = document.querySelector('#persona_lore_button');
        if (!button) return;
        const ctx = context();
        const count = ctx.powerUserSettings.personas?.[user_avatar] ? bindings(ctx).length : 0;
        button.classList.toggle('world_set', count > 0);
        let badge = button.querySelector('.mpl-count');
        if (count > 1) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'mpl-count';
                button.append(badge);
            }
            if (badge.textContent !== String(count)) badge.textContent = String(count);
            badge.setAttribute('aria-label', `${count} persona lorebooks`);
        } else badge?.remove();
    }

    function refresh() {
        if (disposed) return;
        for (const [root, panel] of panels) {
            if (!root.isConnected) {
                panel.dispose();
                panels.delete(root);
            } else panel.render();
        }
        updateButton();
    }

    function changed() {
        revision++;
        warnings.clear();
        refresh();
    }

    async function inject(payload) {
        const ctx = context();
        const avatar = user_avatar;
        const currentDescriptor = descriptor(ctx, avatar);
        if (disposed || !ctx.powerUserSettings.personas?.[avatar] || !currentDescriptor) return;
        const metadata = ctx.chatMetadata;
        const chatIdentity = getChatIdentity(ctx);
        const currentRevision = revision;
        const signature = JSON.stringify(bindings(ctx));
        const isCurrent = () => {
            const latest = context();
            return !disposed && currentRevision === revision && avatar === user_avatar
                && currentDescriptor === descriptor(latest) && metadata === latest.chatMetadata
                && chatIdentity === getChatIdentity(latest) && signature === JSON.stringify(bindings(latest));
        };
        await addPersonaLore({
            payload,
            names: uniqueNames(currentDescriptor[METADATA_KEY]?.books)
                .filter(name => name !== ctx.powerUserSettings.persona_description_lorebook),
            availableNames: ctx.getWorldInfoNames(),
            loadWorldInfo: ctx.loadWorldInfo,
            isCurrent,
            onUnavailable(name, error) {
                const key = JSON.stringify([avatar, name]);
                if (warnings.has(key)) return;
                warnings.add(key);
                console.warn('[Multiple Persona Lorebooks] Could not load bound book:', name, error ?? 'Missing or unreadable');
                // Never interpolate user-controlled book names into toast HTML.
                toastr.warning('A bound persona lorebook is missing or could not be loaded. Open Persona Lore to check the selection.', 'Multiple Persona Lorebooks');
            },
        });
    }

    function enhance(root) {
        if (disposed || panels.has(root)) return;
        const nativeSelect = root.querySelector('.persona_world_info_selector');
        const ctx = context();
        const avatar = user_avatar;
        if (!nativeSelect || !ctx.powerUserSettings.personas?.[avatar]) return;
        const currentDescriptor = getOrCreatePersonaDescriptor();
        // The host captures the persona before asynchronously loading its template.
        // Keep a late-arriving popup from binding a different persona after a switch.
        const opening = opener;
        opener = undefined;
        const personaName = root.querySelector('.persona_name');
        const openedForCurrent = (!opening || (opening.avatar === avatar && (!opening.descriptor || opening.descriptor === currentDescriptor)))
            && personaName?.textContent === ctx.powerUserSettings.personas[avatar];
        const abort = new AbortController();
        const events = { signal: abort.signal };
        const nativeRange = nativeSelect.closest('.range-block-range') ?? nativeSelect;
        const nativeDescription = root.querySelector('.range-block-counter');
        const heading = root.querySelector('[data-i18n="Persona Lorebook for"]');
        const headingText = heading?.textContent;
        const headingKey = heading?.getAttribute('data-i18n');
        if (heading) {
            heading.textContent = 'Persona Lorebooks for';
            heading.setAttribute('data-i18n', 'Persona Lorebooks for');
        }
        nativeRange.classList.add('mpl-native-hidden');
        nativeDescription?.classList.add('mpl-native-hidden');
        root.classList.add('mpl-enhanced');

        const picker = document.createElement('div');
        picker.className = 'mpl-picker';
        picker.innerHTML = `
            <p class="mpl-description">Choose the lorebooks to bind to this persona. Selections are saved automatically.</p>
            <input class="mpl-search text_pole" type="search" placeholder="Search lorebooks…" aria-label="Search persona lorebooks" autocomplete="off">
            <div class="mpl-toolbar">
                <span class="mpl-selection-count" role="status" aria-live="polite"></span>
                <button type="button" class="mpl-clear menu_button">Clear bindings</button>
            </div>
            <div class="mpl-list" role="group" aria-label="Persona lorebook bindings"></div>
            <p class="mpl-empty" hidden>No matching lorebooks.</p>
            <small class="mpl-help">The primary book is used by the Persona Lore edit shortcut and commands that use one lorebook. Every checked book participates in this persona’s lore scan across chats.</small>
            <div class="mpl-status" role="status" aria-live="polite"></div>
            <button type="button" class="mpl-retry menu_button" hidden>Retry save</button>`;
        root.append(picker);
        const search = picker.querySelector('.mpl-search');
        const count = picker.querySelector('.mpl-selection-count');
        const clear = picker.querySelector('.mpl-clear');
        const list = picker.querySelector('.mpl-list');
        const empty = picker.querySelector('.mpl-empty');
        const status = picker.querySelector('.mpl-status');
        const retry = picker.querySelector('.mpl-retry');
        const rows = new Map();
        let busy = false;
        let alive = true;
        let savedMessage = '';

        function isCurrent() {
            const latest = context();
            return alive && !disposed && openedForCurrent && avatar === user_avatar
                && Boolean(latest.powerUserSettings.personas?.[avatar])
                && currentDescriptor === descriptor(latest, avatar);
        }

        function currentBindings() {
            return getBindings(currentDescriptor, isCurrent()
                ? context().powerUserSettings.persona_description_lorebook : currentDescriptor.lorebook);
        }

        async function commit(next) {
            if (!isCurrent() || busy) return;
            const focused = picker.contains(document.activeElement) ? document.activeElement : null;
            const latest = context();
            setBindings(currentDescriptor, next);
            latest.powerUserSettings.persona_description_lorebook = currentDescriptor.lorebook;
            nativeSelect.value = currentDescriptor.lorebook;
            revision++;
            warnings.clear();
            busy = true;
            savedMessage = '';
            retry.hidden = true;
            refresh();
            try {
                latest.saveSettingsDebounced();
                await latest.eventSource.emit(latest.eventTypes.PERSONA_UPDATED, avatar);
                savedMessage = 'Selection updated.';
            } catch (error) {
                console.error('[Multiple Persona Lorebooks] Could not request settings save', error);
                savedMessage = 'Could not request a save. Use Retry save before leaving.';
                retry.hidden = false;
            } finally {
                busy = false;
                if (alive && !disposed) refresh();
                if (isCurrent() && focused && document.activeElement === document.body) {
                    const focusTarget = focused.isConnected && !focused.disabled ? focused : search;
                    focusTarget.focus({ preventScroll: true });
                }
            }
        }

        function makeRow(name) {
            const row = document.createElement('div');
            row.className = 'mpl-row';
            const label = document.createElement('label');
            label.className = 'mpl-book-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = name;
            const text = document.createElement('span');
            text.className = 'mpl-book-name';
            text.textContent = name;
            const missing = document.createElement('span');
            missing.className = 'mpl-missing';
            missing.textContent = 'Missing';
            label.append(checkbox, text, missing);
            const primary = document.createElement('button');
            primary.type = 'button';
            primary.className = 'mpl-primary menu_button';
            checkbox.addEventListener('change', () => {
                const books = currentBindings();
                void commit(checkbox.checked ? [...books, name] : books.filter(book => book !== name));
            }, events);
            primary.addEventListener('click', () => {
                void commit([name, ...currentBindings().filter(book => book !== name)]);
            }, events);
            row.append(label, primary);
            return { row, checkbox, primary, missing };
        }

        function render() {
            const current = isCurrent();
            if (current && personaName) personaName.textContent = context().powerUserSettings.personas[avatar];
            const books = currentBindings();
            const selected = new Set(books);
            const available = new Set(context().getWorldInfoNames());
            const names = uniqueNames([...available, ...books]).sort((a, b) => a.localeCompare(b));
            const allNames = new Set(names);
            const query = search.value.toLocaleLowerCase();
            let visible = 0;
            for (const [name, item] of rows) {
                if (!allNames.has(name)) {
                    item.row.remove();
                    rows.delete(name);
                }
            }
            for (const [index, name] of names.entries()) {
                if (!rows.has(name)) rows.set(name, makeRow(name));
                const item = rows.get(name);
                if (list.children[index] !== item.row) list.insertBefore(item.row, list.children[index] ?? null);
                item.checkbox.checked = selected.has(name);
                item.checkbox.disabled = !current || busy;
                item.row.classList.toggle('mpl-selected', selected.has(name));
                item.row.hidden = !name.toLocaleLowerCase().includes(query);
                if (!item.row.hidden) visible++;
                item.missing.hidden = available.has(name);
                item.primary.hidden = !selected.has(name);
                const isPrimary = (current ? context().powerUserSettings.persona_description_lorebook : currentDescriptor.lorebook) === name;
                item.primary.textContent = isPrimary ? 'Primary' : 'Make primary';
                item.primary.setAttribute('aria-label', isPrimary ? `${name} is the primary lorebook` : `Make ${name} the primary lorebook`);
                item.primary.disabled = !current || busy || isPrimary;
                item.primary.classList.toggle('mpl-is-primary', isPrimary);
            }
            count.textContent = `${books.length} ${books.length === 1 ? 'lorebook' : 'lorebooks'} bound`;
            empty.hidden = visible > 0;
            empty.textContent = names.length ? 'No matching lorebooks.' : 'Create or import a lorebook in World Info to get started.';
            search.disabled = !current;
            clear.disabled = !current || busy || books.length === 0;
            retry.disabled = !current || busy;
            status.textContent = !current ? 'This persona changed. Close this dialog and reopen Persona Lore for the current persona.'
                : busy ? 'Updating selection…' : savedMessage;
        }

        search.addEventListener('input', render, events);
        clear.addEventListener('click', () => { void commit([]); }, events);
        retry.addEventListener('click', () => { void commit(currentBindings()); }, events);
        panels.set(root, {
            render,
            dispose() {
                alive = false;
                abort.abort();
                picker.remove();
                nativeRange.classList.remove('mpl-native-hidden');
                nativeDescription?.classList.remove('mpl-native-hidden');
                root.classList.remove('mpl-enhanced');
                nativeSelect.value = currentDescriptor.lorebook ?? '';
                if (heading) {
                    heading.textContent = headingText;
                    heading.setAttribute('data-i18n', headingKey);
                }
            },
        });
        render();
    }

    function inspect(node) {
        if (!(node instanceof Element)) return;
        if (node.matches('.persona_world')) enhance(node);
        node.querySelectorAll('.persona_world').forEach(enhance);
    }

    const observer = new MutationObserver(records => {
        if (disposed) return;
        let shouldRefresh = false;
        for (const record of records) {
            if (record.target instanceof Element && record.target.closest('.mpl-picker, .mpl-count')) continue;
            if (record.target instanceof Element && record.target.closest('#world_info, #world_editor_select')) shouldRefresh = true;
            for (const node of record.addedNodes) {
                inspect(node);
                if (node instanceof Element && (node.matches('#persona_lore_button') || node.querySelector('#persona_lore_button'))) shouldRefresh = true;
            }
        }
        for (const [root, panel] of panels) {
            if (!root.isConnected) {
                panel.dispose();
                panels.delete(root);
            }
        }
        if (shouldRefresh) refresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Delegation also observes synthetic clicks used by other persona extensions.
    const openerSelector = '#persona_lore_button, #persona-management-dropdown';
    const openerEvents = 'click.mpl change.mpl touchstart.mpl';
    function captureOpener(event) {
        const ctx = context();
        opener = !ctx.powerUserSettings.personas?.[user_avatar]
            || (event.type === 'click' && !event.shiftKey && !event.altKey
                && ctx.powerUserSettings.persona_description_lorebook) ? undefined
            : { avatar: user_avatar, descriptor: descriptor(ctx) };
    }
    $(document).on(openerEvents, openerSelector, captureOpener);
    listeners.push(() => $(document).off(openerEvents, openerSelector, captureOpener));
    listen(context().eventTypes.WORLDINFO_ENTRIES_LOADED, inject, true);
    listen(context().eventTypes.PERSONA_CREATED, event => {
        if (event?.duplicatedFromAvatarId) {
            const ctx = context();
            const target = descriptor(ctx, event.avatarId);
            if (target) {
                copyExtraBindings(descriptor(ctx, event.duplicatedFromAvatarId), target);
                ctx.saveSettingsDebounced();
            }
        }
        changed();
    });
    for (const type of ['PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED',
        'CHAT_CHANGED', 'SETTINGS_LOADED_AFTER', 'WORLDINFO_UPDATED']) listen(context().eventTypes[type], changed);
    listen(context().eventTypes.APP_READY, refresh);
    inspect(document.body);
    refresh();

    return {
        dispose() {
            disposed = true;
            revision++;
            observer.disconnect();
            listeners.forEach(remove => remove());
            panels.forEach(panel => panel.dispose());
            panels.clear();
            document.querySelectorAll('#persona_lore_button .mpl-count').forEach(badge => badge.remove());
            document.querySelector('#persona_lore_button')?.classList.toggle('world_set', Boolean(context().powerUserSettings.persona_description_lorebook));
        },
    };
}
