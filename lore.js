/** Additional bindings stay on the persona; its primary remains a native string. */
export const METADATA_KEY = 'multi_persona_lorebooks';

export function uniqueNames(names) {
    return [...new Set((Array.isArray(names) ? names : [])
        .filter(name => typeof name === 'string' && name.length > 0))];
}

export function getBindings(descriptor, primary = descriptor?.lorebook) {
    return uniqueNames([primary, ...uniqueNames(descriptor?.[METADATA_KEY]?.books)]);
}

/** Preserve unrelated descriptor fields and the host's primary-string contract. */
export function setBindings(descriptor, names) {
    const books = uniqueNames(names);
    descriptor.lorebook = books[0] ?? '';
    if (books.length > 1) descriptor[METADATA_KEY] = { version: 1, books: books.slice(1) };
    else delete descriptor[METADATA_KEY];
    return books;
}

/** The host duplicates known fields only; its PERSONA_CREATED event supplies the source. */
export function copyExtraBindings(source, target) {
    const books = uniqueNames(source?.[METADATA_KEY]?.books);
    if (books.length) target[METADATA_KEY] = { version: 1, books: [...books] };
    else delete target[METADATA_KEY];
    return books;
}

/** Different characters and groups may reuse the same chat title. */
export function getChatIdentity(context) {
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    if (chatId === undefined || chatId === null || chatId === '') return null;
    const group = context.groupId;
    const owner = group !== undefined && group !== null && group !== ''
        ? ['group', String(group)]
        : ['character', context.characters?.[context.characterId]?.avatar ?? String(context.characterId)];
    return JSON.stringify([...owner, String(chatId)]);
}

function entryKey(entry) {
    return JSON.stringify([entry.world, String(entry.uid)]);
}

/**
 * Insert before the native scanner sorts, parses decorators, hashes, or budgets entries.
 * Preserve the four array references held by the host. Loading is bounded and the
 * commit is atomic, so an abandoned persona/chat cannot receive partial results.
 * Global and chat sources retain their host priority; character entries move to persona.
 */
export async function addPersonaLore({ payload, names, availableNames, loadWorldInfo, isCurrent = () => true, onUnavailable = () => {} }) {
    if (!Array.isArray(payload?.personaLore)) return;
    const globalLore = Array.isArray(payload.globalLore) ? payload.globalLore : [];
    const chatLore = Array.isArray(payload.chatLore) ? payload.chatLore : [];
    const characterLore = Array.isArray(payload.characterLore) ? payload.characterLore : [];
    const personaLore = payload.personaLore;
    const available = new Set(uniqueNames(availableNames));
    const activeBooks = new Set([...globalLore, ...chatLore, ...personaLore].map(entry => entry.world));
    const requests = uniqueNames(names).filter(name => !activeBooks.has(name));
    const results = new Array(requests.length);
    let cursor = 0;

    async function worker() {
        while (cursor < requests.length && isCurrent()) {
            const index = cursor++;
            const name = requests[index];
            if (!available.has(name)) {
                results[index] = { name, missing: true };
                continue;
            }
            const existing = characterLore.filter(entry => entry.world === name);
            if (existing.length) {
                results[index] = { name, entries: existing };
                continue;
            }
            try {
                const data = await loadWorldInfo(name);
                if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
                    results[index] = { name, missing: true };
                    continue;
                }
                const entries = Object.values(data.entries)
                    .filter(entry => entry && typeof entry === 'object' && entry.uid !== undefined && entry.uid !== null)
                    .map(({ uid, world: _world, ...rest }) => ({ uid, world: name, ...rest }));
                results[index] = { name, entries };
            } catch (error) {
                results[index] = { name, missing: true, error };
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker));
    if (!isCurrent()) return;
    const currentBooks = new Set([...globalLore, ...chatLore, ...personaLore].map(entry => entry.world));
    const seen = new Set([...globalLore, ...chatLore, ...personaLore].map(entryKey));
    for (const result of results) {
        if (!result || currentBooks.has(result.name)) continue;
        if (result.missing) {
            onUnavailable(result.name, result.error);
            continue;
        }
        for (let index = characterLore.length - 1; index >= 0; index--) {
            if (characterLore[index].world === result.name) characterLore.splice(index, 1);
        }
        for (const entry of result.entries) {
            const key = entryKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            personaLore.push(entry);
        }
        currentBooks.add(result.name);
    }
}
