import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { addPersonaLore, copyExtraBindings, getBindings, getChatIdentity, METADATA_KEY, setBindings, uniqueNames } from '../lore.js';

const entry = (world, uid, content = `${world}:${uid}`) => ({ uid, world, content });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map((value, index) => [String(index), value])) });
const payload = (overrides = {}) => ({ globalLore: [], characterLore: [], personaLore: [], chatLore: [], ...overrides });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('persona bindings preserve the primary-string contract, unrelated fields, and backup JSON', () => {
    const descriptor = { lorebook: 'Primary', description: 'Keep description', connections: [{ type: 'character', id: 'card.png' }] };
    const unrelated = structuredClone(descriptor);
    assert.deepEqual(setBindings(descriptor, ['Primary', 'Extra one', 'Extra two']), ['Primary', 'Extra one', 'Extra two']);
    assert.equal(descriptor.lorebook, 'Primary');
    assert.deepEqual(descriptor[METADATA_KEY], { version: 1, books: ['Extra one', 'Extra two'] });
    assert.deepEqual(getBindings(JSON.parse(JSON.stringify(descriptor))), ['Primary', 'Extra one', 'Extra two']);
    const { [METADATA_KEY]: _extras, ...native } = descriptor;
    assert.deepEqual(native, unrelated);
});

test('removing a primary promotes the next binding and clear keeps an empty native string', () => {
    const descriptor = { lorebook: 'First', [METADATA_KEY]: { version: 1, books: ['Second', 'Third'] }, title: 'Keep title' };
    setBindings(descriptor, getBindings(descriptor).filter(name => name !== 'First'));
    assert.equal(descriptor.lorebook, 'Second');
    assert.deepEqual(getBindings(descriptor), ['Second', 'Third']);
    setBindings(descriptor, ['Third']);
    assert.equal(Object.hasOwn(descriptor, METADATA_KEY), false);
    setBindings(descriptor, []);
    assert.deepEqual(descriptor, { lorebook: '', title: 'Keep title' });
});

test('native active-primary override and malformed imported bindings are handled without rewriting names', () => {
    assert.deepEqual(uniqueNames(['A', '', 'A', 'a', null, 42, ' with spaces ']), ['A', 'a', ' with spaces ']);
    assert.deepEqual(uniqueNames('A'), []);
    const descriptor = { lorebook: 'Old primary', [METADATA_KEY]: { books: ['Extra', 'Extra', null, 'Current primary'] } };
    assert.deepEqual(getBindings(descriptor, 'Current primary'), ['Current primary', 'Extra']);
    assert.deepEqual(getBindings(descriptor, ''), ['Extra', 'Current primary']);
    assert.deepEqual(getBindings({ lorebook: 'A', [METADATA_KEY]: { books: 'B' } }), ['A']);
    assert.deepEqual(getBindings(undefined), []);
});

test('copying bindings for a duplicated persona deep-copies extras without changing native fields', () => {
    const source = { lorebook: 'Primary', [METADATA_KEY]: { version: 1, books: ['Extra', 'Extra', null, 'Other'] } };
    const target = { lorebook: 'Primary', description: 'Native copy' };
    assert.deepEqual(copyExtraBindings(source, target), ['Extra', 'Other']);
    assert.deepEqual(getBindings(target), ['Primary', 'Extra', 'Other']);
    assert.notEqual(target[METADATA_KEY], source[METADATA_KEY]);
    assert.notEqual(target[METADATA_KEY].books, source[METADATA_KEY].books);
    target[METADATA_KEY].books.push('Duplicate only');
    assert.deepEqual(source[METADATA_KEY].books, ['Extra', 'Extra', null, 'Other']);
    assert.equal(target.description, 'Native copy');
    copyExtraBindings({}, target);
    assert.equal(Object.hasOwn(target, METADATA_KEY), false);
    assert.equal(target.lorebook, 'Primary');
});

test('bindings remain isolated between personas and need no global World Info selections', () => {
    const first = { lorebook: 'Shared primary' };
    const second = { lorebook: 'Shared primary' };
    setBindings(first, ['Shared primary', 'First only']);
    setBindings(second, ['Shared primary', 'Second only']);
    setBindings(first, ['First only']);
    assert.deepEqual(getBindings(first), ['First only']);
    assert.deepEqual(getBindings(second), ['Shared primary', 'Second only']);
});

test('chat identity distinguishes owner types and repeated titles and supports numeric zero', () => {
    const first = { characterId: 0, characters: [{ avatar: 'alice.png' }], getCurrentChatId: () => 'same title' };
    assert.notEqual(getChatIdentity(first), getChatIdentity({ ...first, characters: [{ avatar: 'bob.png' }] }));
    assert.notEqual(getChatIdentity(first), getChatIdentity({ ...first, getCurrentChatId: () => 'other title' }));
    assert.notEqual(getChatIdentity(first), getChatIdentity({ ...first, groupId: 0 }));
    assert.notEqual(getChatIdentity({ ...first, groupId: 0 }), getChatIdentity({ ...first, groupId: 1 }));
    assert.equal(getChatIdentity({ ...first, characterId: 1, characters: [null, { avatar: 'alice.png' }] }), getChatIdentity(first));
    assert.deepEqual(JSON.parse(getChatIdentity({ chatId: 0, groupId: 0 })), ['group', '0', '0']);
    assert.equal(getChatIdentity({ chatId: '' }), null);
    assert.equal(getChatIdentity({}), null);
});

test('native global, chat, and existing persona books are not reloaded and all arrays stay in place', async () => {
    const primary = entry('Primary', 1);
    const global = entry('Global', 2);
    const chat = entry('Chat', 3);
    const state = payload({ personaLore: [primary], globalLore: [global], chatLore: [chat] });
    const references = { ...state };
    const loaded = [];
    await addPersonaLore({
        payload: state, names: ['Primary', 'Global', 'Chat', 'Extra', 'Extra'], availableNames: ['Primary', 'Global', 'Chat', 'Extra'],
        loadWorldInfo: async name => { loaded.push(name); return book({ uid: 4, content: 'extra' }); },
    });
    assert.deepEqual(loaded, ['Extra']);
    for (const key of Object.keys(references)) assert.equal(state[key], references[key]);
    assert.equal(state.personaLore[0], primary);
    assert.equal(state.globalLore[0], global);
    assert.equal(state.chatLore[0], chat);
    assert.deepEqual(state.personaLore[1], entry('Extra', 4, 'extra'));
});

test('existing character entries move to persona priority and retain earlier extension edits', async () => {
    const shared = { ...entry('Shared', 0), priorExtensionEdit: 'preserve' };
    const duplicate = entry('Shared', '0', 'duplicate');
    const other = entry('Character only', 1);
    const state = payload({ characterLore: [shared, duplicate, other] });
    await addPersonaLore({
        payload: state, names: ['Shared'], availableNames: ['Shared'],
        loadWorldInfo: async () => assert.fail('existing entries must not be reloaded'),
    });
    assert.deepEqual(state.characterLore, [other]);
    assert.deepEqual(state.personaLore, [shared]);
    assert.equal(state.personaLore[0], shared);
});

test('a chat extension that already promoted an overlapping book keeps chat priority', async () => {
    const shared = { ...entry('Shared', 0), priorExtensionEdit: 'chat edit' };
    const state = payload({ chatLore: [shared], characterLore: [entry('Other', 1)] });
    await addPersonaLore({
        payload: state, names: ['Shared'], availableNames: ['Shared'],
        loadWorldInfo: async () => assert.fail('chat source wins without reloading'),
    });
    assert.deepEqual(state.personaLore, []);
    assert.equal(state.chatLore[0], shared);
});

test('entry identity deduplicates numeric/string uids within a book and accepts uid zero', async () => {
    const state = payload();
    await addPersonaLore({
        payload: state, names: ['First', 'Second'], availableNames: ['First', 'Second'],
        loadWorldInfo: async name => name === 'First'
            ? book({ uid: 0, content: 'first zero' }, { uid: '0', content: 'duplicate zero' }, { uid: 1 }, { uid: '1' }, { content: 'no uid' }, null)
            : book({ uid: 0, content: 'different book zero' }),
    });
    assert.deepEqual(state.personaLore.map(({ world, uid }) => [world, uid]), [['First', 0], ['First', 1], ['Second', 0]]);
    assert.equal(state.personaLore[0].content, 'first zero');
});

test('failed and malformed books do not block valid books and do not erase saved names', async () => {
    const descriptor = {};
    const names = ['Good first', 'Throws', 'Malformed', 'Missing', 'Good last'];
    setBindings(descriptor, names);
    const serialized = JSON.stringify(descriptor);
    const state = payload();
    const failure = new Error('service unavailable');
    const unavailable = [];
    await addPersonaLore({
        payload: state, names: getBindings(descriptor), availableNames: names.filter(name => name !== 'Missing'),
        loadWorldInfo: async name => {
            if (name === 'Throws') throw failure;
            if (name === 'Malformed') return { entries: [] };
            return book({ uid: 0, content: name });
        },
        onUnavailable: (name, error) => unavailable.push([name, error]),
    });
    assert.deepEqual(state.personaLore.map(value => value.world), ['Good first', 'Good last']);
    assert.deepEqual(unavailable, [['Throws', failure], ['Malformed', undefined], ['Missing', undefined]]);
    assert.equal(JSON.stringify(descriptor), serialized);
});

test('a missing binding can load when its book is restored', async () => {
    const state = payload();
    const unavailable = [];
    await addPersonaLore({
        payload: state, names: ['Missing'], availableNames: [],
        loadWorldInfo: async () => assert.fail('missing books must not be requested'),
        onUnavailable: name => unavailable.push(name),
    });
    assert.deepEqual(unavailable, ['Missing']);
    await addPersonaLore({ payload: state, names: ['Missing'], availableNames: ['Missing'], loadWorldInfo: async () => book({ uid: 0, content: 'restored' }) });
    assert.deepEqual(state.personaLore, [entry('Missing', 0, 'restored')]);
});

test('loading is bounded to four requests and commits in binding order after all finish', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `Book ${index}`);
    const state = payload();
    const gates = new Map(names.map(name => [name, deferred()]));
    const started = [];
    let running = 0;
    let peak = 0;
    const operation = addPersonaLore({
        payload: state, names, availableNames: names,
        loadWorldInfo: async name => {
            started.push(name);
            peak = Math.max(peak, ++running);
            await gates.get(name).promise;
            running--;
            return book({ uid: 0, content: name });
        },
    });
    assert.equal(started.length, 4);
    assert.deepEqual(state.personaLore, []);
    gates.get('Book 3').resolve();
    await tick();
    assert.equal(started.length, 5);
    assert.deepEqual(state.personaLore, []);
    for (const gate of gates.values()) gate.resolve();
    await operation;
    assert.equal(peak, 4);
    assert.equal(running, 0);
    assert.deepEqual(state.personaLore.map(value => value.world), names);
});

test('persona/chat changes cancel entry moves, fresh loads, and warning callbacks atomically', async () => {
    const state = payload({ globalLore: [entry('Global', 0)], personaLore: [entry('Primary', 1)], characterLore: [entry('Promote', 2)], chatLore: [entry('Chat', 3)] });
    const before = structuredClone(state);
    const references = { ...state };
    const gate = deferred();
    let current = true;
    const operation = addPersonaLore({
        payload: state, names: ['Promote', 'Waiting', 'Missing'], availableNames: ['Promote', 'Waiting'],
        loadWorldInfo: async () => { await gate.promise; return book({ uid: 4 }); },
        isCurrent: () => current,
        onUnavailable: () => assert.fail('stale warnings must be suppressed'),
    });
    current = false;
    gate.resolve();
    await operation;
    assert.deepEqual(state, before);
    for (const key of Object.keys(references)) assert.equal(state[key], references[key]);
});

test('an already canceled scan does not start loading', async () => {
    const state = payload();
    await addPersonaLore({ payload: state, names: ['Extra'], availableNames: ['Extra'], isCurrent: () => false, loadWorldInfo: async () => assert.fail('no load') });
    assert.deepEqual(state.personaLore, []);
});

test('each scan loads fresh book data so edits between generations take effect', async () => {
    let content = 'before edit';
    let loads = 0;
    const options = { names: ['Extra'], availableNames: ['Extra'], loadWorldInfo: async () => { loads++; return book({ uid: 0, content }); } };
    const first = payload();
    await addPersonaLore({ ...options, payload: first });
    content = 'after edit';
    const second = payload();
    await addPersonaLore({ ...options, payload: second });
    assert.equal(loads, 2);
    assert.equal(first.personaLore[0].content, 'before edit');
    assert.equal(second.personaLore[0].content, 'after edit');
});

test('cached entry objects remain unchanged and converted property order matches native hashing', async () => {
    const sourceEntry = Object.freeze({ content: 'original', uid: 0, comment: 'comment', order: 100, key: Object.freeze(['trigger']) });
    const data = Object.freeze({ entries: Object.freeze({ 0: sourceEntry }) });
    const before = JSON.stringify(data);
    const state = payload();
    await addPersonaLore({ payload: state, names: ['Extra'], availableNames: ['Extra'], loadWorldInfo: async () => data });
    const nativeEntry = (({ uid, ...rest }) => ({ uid, world: 'Extra', ...rest }))(sourceEntry);
    assert.notEqual(state.personaLore[0], sourceEntry);
    assert.equal(JSON.stringify(state.personaLore[0]), JSON.stringify(nativeEntry));
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(hash(state.personaLore[0]), hash(nativeEntry));
    state.personaLore[0].content = 'native decorated content';
    state.personaLore[0].hash = 123;
    assert.equal(JSON.stringify(data), before);
});

test('the loaded filename defines world identity despite a stale world field in source data', async () => {
    const state = payload();
    await addPersonaLore({ payload: state, names: ['Actual filename'], availableNames: ['Actual filename'], loadWorldInfo: async () => book({ uid: 0, world: 'Old filename' }) });
    assert.equal(state.personaLore[0].world, 'Actual filename');
});

test('unexpected event payloads are ignored without loading', async () => {
    for (const eventPayload of [undefined, {}, { personaLore: null }]) {
        await addPersonaLore({ payload: eventPayload, names: ['Extra'], availableNames: ['Extra'], loadWorldInfo: async () => assert.fail('invalid payload must not load') });
    }
});

test('a source added while loading remains authoritative when the batch commits', async () => {
    const state = payload();
    const gate = deferred();
    const operation = addPersonaLore({ payload: state, names: ['Shared'], availableNames: ['Shared'], loadWorldInfo: async () => { await gate.promise; return book({ uid: 0 }); } });
    const authoritative = entry('Shared', 0, 'added to chat while pending');
    state.chatLore.push(authoritative);
    gate.resolve();
    await operation;
    assert.deepEqual(state.personaLore, []);
    assert.equal(state.chatLore[0], authoritative);
});
