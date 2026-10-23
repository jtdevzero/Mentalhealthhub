import test from 'node:test';
import assert from 'node:assert/strict';
import { PartyHistory } from '../party-history.js';

const key = 'homlok-party-v1';
const cards = Object.freeze([
  Object.freeze({ id: 'world-tom-hanks', name: 'Tom Hanks', category: 'world' }),
  Object.freeze({ id: 'hu-kern-andras', name: 'Kern András', category: 'hungarian' }),
  Object.freeze({ id: 'world-meryl-streep', name: 'Meryl Streep', category: 'world' }),
]);
function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[key, initial]]);
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
