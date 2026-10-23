import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTORS, MOVIES, DECKS, getDeckCards } from '../data.js';

test('each deck offers valid unique cards and a matching count unit', () => {
  assert.deepEqual(DECKS.map((deck) => deck.id), ['world', 'hungarian', 'movies', 'mix']);
  for (const deck of DECKS) {
    const cards = getDeckCards(deck.id);
    assert.ok(cards.length > 0);
    assert.ok(deck.unit);
    assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
    for (const card of cards) {
      assert.ok(card.name.trim());
      assert.ok(['actor', 'movie'].includes(card.type));
    }
  }
  assert.deepEqual(getDeckCards('unknown'), []);
});

test('movie rounds contain films, actor rounds contain actors, mixed rounds offer both', () => {
  assert.ok(MOVIES.length >= 100);
  assert.equal(new Set(MOVIES.map((card) => card.name)).size, MOVIES.length);
  assert.ok(getDeckCards('movies').every((card) => card.type === 'movie'));
  for (const id of ['world', 'hungarian']) {
    assert.ok(getDeckCards(id).every((card) => card.type === 'actor' && card.origin === id));
  }
  const mixed = getDeckCards('mix');
  assert.equal(mixed.length, ACTORS.length + MOVIES.length);
  assert.ok(mixed.some((card) => card.type === 'actor'));
  assert.ok(mixed.some((card) => card.type === 'movie'));
});
