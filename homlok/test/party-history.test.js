import test from 'node:test';
import assert from 'node:assert/strict';
import { PartyHistory } from '../party-history.js';

const key = 'homlok-party-v1';
const exclusionsKey = 'homlok-exclusions-v1';
const cards = Object.freeze([
  Object.freeze({ id: 'world-tom-hanks', name: 'Tom Hanks', category: 'world' }),
  Object.freeze({ id: 'hu-kern-andras', name: 'Kern András', category: 'hungarian' }),
  Object.freeze({ id: 'world-meryl-streep', name: 'Meryl Streep', category: 'world' }),
]);
function memoryStorage(initial = null, exclusions = null) {
  const values = new Map(initial === null ? [] : [[key, initial]]);
  if (exclusions !== null) values.set(exclusionsKey, exclusions);
  return {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
  };
}

test('seen cards stay excluded across overlapping category selections and rounds', () => {
  const history = new PartyHistory({ cards });
  const world = cards.filter(card => card.category === 'world');
  assert.deepEqual(history.remaining(world), world);
  assert.equal(history.markSeen(cards[0].id), true);
  assert.deepEqual(history.remaining(world), [cards[2]]);
  assert.deepEqual(history.remaining(cards), [cards[1], cards[2]]);
  assert.equal(history.markSeen(cards[1].id), true);
  assert.deepEqual(history.remaining([cards[1]]), []);
  assert.equal(history.usedCount, 2);
  assert.equal(history.totalCount, 3);
  assert.equal(history.hasSeen(cards[0].id), true);
  assert.equal(history.hasSeen(cards[2].id), false);
});

test('reading a deck does not mark cards and returns an independent, unique array', () => {
  const history = new PartyHistory({ cards });
  const deck = [cards[0], cards[0], cards[1]];
  const before = [...deck];
  const available = history.remaining(deck);
  assert.deepEqual(available, [cards[0], cards[1]]);
  assert.deepEqual(deck, before);
  assert.equal(history.usedCount, 0);
  available.pop();
  assert.deepEqual(history.remaining(deck), [cards[0], cards[1]]);
  assert.equal(history.markSeen('unknown'), false);
  assert.equal(history.markSeen(cards[0].id), true);
  assert.equal(history.markSeen(cards[0].id), false);
  assert.equal(history.usedCount, 1);
});

test('storage preserves history after reload, and adding cards preserves stable IDs', () => {
  const storage = memoryStorage();
  const first = new PartyHistory({ cards, storage });
  first.markSeen(cards[0].id);
  first.markSeen(cards[1].id);
  assert.deepEqual(JSON.parse(storage.getItem(key)), {
    version: 1,
    seen: [cards[0].id, cards[1].id],
  });
  const extra = { id: 'world-julia-roberts', name: 'Julia Roberts' };
  const expanded = [...cards, extra];
  const reloaded = new PartyHistory({ cards: expanded, storage });
  assert.equal(reloaded.usedCount, 2);
  assert.equal(reloaded.totalCount, 4);
  assert.deepEqual(reloaded.remaining(expanded), [cards[2], extra]);
});

test('saved IDs are deduplicated and pruned when the card catalog changes', () => {
  const storage = memoryStorage(JSON.stringify({
    version: 1,
    seen: [cards[0].id, 'removed-card', cards[0].id, null, 123],
  }));
  const history = new PartyHistory({ cards, storage });
  assert.equal(history.usedCount, 1);
  assert.deepEqual(history.remaining(cards), [cards[1], cards[2]]);
  assert.deepEqual(JSON.parse(storage.getItem(key)), { version: 1, seen: [cards[0].id] });
});

test('reset makes every card available and survives a reload', () => {
  const storage = memoryStorage();
  const history = new PartyHistory({ cards, storage });
  for (const card of cards) history.markSeen(card.id);
  assert.deepEqual(history.remaining(cards), []);
  history.reset();
  assert.equal(history.usedCount, 0);
  assert.deepEqual(history.remaining(cards), cards);
  assert.deepEqual(new PartyHistory({ cards, storage }).remaining(cards), cards);
});

test('malformed or incompatible saves start a usable empty history', () => {
  for (const value of ['{bad json', 'null', '[]', '{}', '{"version":2,"seen":[]}', '{"version":1,"seen":"bad"}']) {
    const history = new PartyHistory({ cards, storage: memoryStorage(value) });
    assert.equal(history.usedCount, 0);
    assert.deepEqual(history.remaining(cards), cards);
    assert.equal(history.markSeen(cards[0].id), true);
    assert.equal(history.usedCount, 1);
  }
});

test('storage read and write failures preserve usable in-memory history', () => {
  const unavailable = {
    getItem() { throw new Error('Blocked storage'); },
    setItem() { throw new Error('Blocked storage'); },
  };
  const history = new PartyHistory({ cards, storage: unavailable });
  assert.equal(history.markSeen(cards[0].id), true);
  assert.deepEqual(history.remaining(cards), [cards[1], cards[2]]);
  history.reset();
  assert.deepEqual(history.remaining(cards), cards);

  const full = {
    getItem: () => JSON.stringify({ version: 1, seen: [cards[0].id] }),
    setItem() { throw new Error('Quota exceeded'); },
  };
  const loaded = new PartyHistory({ cards, storage: full });
  assert.equal(loaded.usedCount, 1);
  assert.equal(loaded.markSeen(cards[1].id), true);
  assert.equal(loaded.usedCount, 2);
});

test('invalid catalogs fail explicitly and unknown candidate cards cannot bypass history', () => {
  assert.throws(() => new PartyHistory(), TypeError);
  assert.throws(() => new PartyHistory({ cards: [cards[0], cards[0]] }), TypeError);
  assert.throws(() => new PartyHistory({ cards: [{ id: '' }] }), TypeError);
  const history = new PartyHistory({ cards });
  assert.deepEqual(history.remaining([{ id: 'not-in-catalog' }]), []);
  assert.throws(() => history.remaining(null), TypeError);
  assert.throws(() => history.remaining([{}]), TypeError);
  const empty = new PartyHistory({ cards: [] });
  assert.equal(empty.totalCount, 0);
  assert.deepEqual(empty.remaining([]), []);
});

test('existing v1 seen history migrates without any exclusions or loss of progress', () => {
  const storage = memoryStorage(JSON.stringify({ version: 1, seen: [cards[0].id] }));
  const history = new PartyHistory({ cards, storage });
  assert.equal(history.usedCount, 1);
  assert.equal(history.excludedCount, 0);
  assert.equal(history.availableCount, cards.length);
  assert.deepEqual(history.excludedIds, []);
  assert.deepEqual(history.remaining(cards), [cards[1], cards[2]]);
  history.exclude(cards[1].id);
  assert.deepEqual(JSON.parse(storage.getItem(key)), { version: 1, seen: [cards[0].id] });
  assert.deepEqual(JSON.parse(storage.getItem(exclusionsKey)), { version: 1, excluded: [cards[1].id] });
});

test('excluding a card removes it from every overlapping deck without marking it seen', () => {
  const history = new PartyHistory({ cards });
  const world = cards.filter(card => card.category === 'world');
  assert.equal(history.exclude(cards[0].id), true);
  assert.equal(history.exclude(cards[0].id), false);
  assert.equal(history.exclude('unknown'), false);
  assert.equal(history.isExcluded(cards[0].id), true);
  assert.equal(history.isExcluded(cards[1].id), false);
  assert.equal(history.hasSeen(cards[0].id), false);
  assert.equal(history.usedCount, 0);
  assert.equal(history.excludedCount, 1);
  assert.equal(history.availableCount, cards.length - 1);
  assert.deepEqual(history.remaining(world), [cards[2]]);
  assert.deepEqual(history.remaining(cards), [cards[1], cards[2]]);
  const copiedIds = history.excludedIds;
  copiedIds.push(cards[1].id);
  copiedIds.splice(0, 1);
  assert.deepEqual(history.excludedIds, [cards[0].id]);
});

test('exclusions survive reload and catalog expansion, while removed IDs are pruned', () => {
  const storage = memoryStorage(null, JSON.stringify({
    version: 1,
    excluded: [cards[0].id, 'removed-card', cards[0].id, 123, null],
  }));
  const history = new PartyHistory({ cards, storage });
  assert.deepEqual(history.excludedIds, [cards[0].id]);
  assert.deepEqual(JSON.parse(storage.getItem(exclusionsKey)), { version: 1, excluded: [cards[0].id] });
  history.exclude(cards[1].id);
  const extra = { id: 'world-julia-roberts', name: 'Julia Roberts' };
  const expanded = [...cards, extra];
  const reloaded = new PartyHistory({ cards: expanded, storage });
  assert.equal(reloaded.excludedCount, 2);
  assert.equal(reloaded.availableCount, 2);
  assert.deepEqual(reloaded.remaining(expanded), [cards[2], extra]);
});

test('restoring a seen card keeps it seen until a new party, while reset keeps exclusions', () => {
  const storage = memoryStorage();
  const history = new PartyHistory({ cards, storage });
  history.markSeen(cards[0].id);
  history.exclude(cards[0].id);
  history.exclude(cards[1].id);
  assert.equal(history.usedCount, 1);
  assert.equal(history.restore(cards[0].id), true);
  assert.equal(history.restore(cards[0].id), false);
  assert.equal(history.restore('unknown'), false);
  assert.equal(history.hasSeen(cards[0].id), true);
  assert.equal(history.isExcluded(cards[0].id), false);
  assert.deepEqual(history.remaining(cards), [cards[2]]);
  history.reset();
  assert.equal(history.usedCount, 0);
  assert.equal(history.excludedCount, 1);
  assert.equal(history.availableCount, 2);
  assert.deepEqual(history.remaining(cards), [cards[0], cards[2]]);
  const reloaded = new PartyHistory({ cards, storage });
  assert.deepEqual(reloaded.remaining(cards), [cards[0], cards[2]]);
  assert.deepEqual(reloaded.excludedIds, [cards[1].id]);
});

test('seen and exclusion saves load independently when either payload is malformed', () => {
  for (const value of ['{bad json', 'null', '[]', '{}', '{"version":2,"excluded":[]}', '{"version":1,"excluded":"bad"}']) {
    const storage = memoryStorage(JSON.stringify({ version: 1, seen: [cards[0].id] }), value);
    const history = new PartyHistory({ cards, storage });
    assert.equal(history.usedCount, 1);
    assert.equal(history.excludedCount, 0);
    assert.equal(history.exclude(cards[1].id), true);
    assert.deepEqual(history.remaining(cards), [cards[2]]);
  }
  const validExclusions = JSON.stringify({ version: 1, excluded: [cards[1].id] });
  const malformedSeen = new PartyHistory({ cards, storage: memoryStorage('{bad json', validExclusions) });
  assert.equal(malformedSeen.usedCount, 0);
  assert.equal(malformedSeen.excludedCount, 1);
  assert.deepEqual(malformedSeen.remaining(cards), [cards[0], cards[2]]);
});

test('storage exceptions do not block exclusions or allow reset to restore excluded cards', () => {
  const unavailable = {
    getItem() { throw new Error('Blocked storage'); },
    setItem() { throw new Error('Blocked storage'); },
  };
  const history = new PartyHistory({ cards, storage: unavailable });
  history.markSeen(cards[0].id);
  assert.equal(history.exclude(cards[1].id), true);
  history.reset();
  assert.deepEqual(history.remaining(cards), [cards[0], cards[2]]);
  assert.equal(history.restore(cards[1].id), true);
  assert.deepEqual(history.remaining(cards), cards);

  const partlyBlocked = {
    getItem(name) {
      if (name === key) throw new Error('Blocked seen history');
      return JSON.stringify({ version: 1, excluded: [cards[1].id] });
    },
    setItem() { throw new Error('Quota exceeded'); },
  };
  const loaded = new PartyHistory({ cards, storage: partlyBlocked });
  assert.equal(loaded.usedCount, 0);
  assert.equal(loaded.excludedCount, 1);
  loaded.reset();
  assert.equal(loaded.isExcluded(cards[1].id), true);
});
