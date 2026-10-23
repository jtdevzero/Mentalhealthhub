import test from 'node:test';
import assert from 'node:assert/strict';
import { Round, tiltState } from '../game-core.js';

const actors = Array.from({ length: 6 }, (_, index) => ({ id: `actor-${index}`, name: `Színész ${index}` }));
const makeRound = options => new Round({ actors, random: () => 0.5, ...options });

test('a round runs from ready through correct and pass answers to exhaustion without repeats', () => {
  const original = structuredClone(actors);
  const round = makeRound();
  assert.equal(round.status, 'ready');
  assert.equal(round.remaining(0), 60);
  assert.equal(round.answer('correct', 0), false);
  assert.equal(round.start(1000), true);
  assert.equal(round.start(1000), false);

  const seen = new Set();
  for (let index = 0; index < actors.length; index += 1) {
    seen.add(round.current.id);
    assert.equal(round.answer(index % 2 ? 'pass' : 'correct', 2000 + index * 1000), true);
  }
  assert.equal(seen.size, actors.length);
  assert.deepEqual(actors, original);
  assert.equal(round.status, 'finished');
  assert.equal(round.reason, 'exhausted');
  assert.equal(round.current, null);
  assert.equal(round.results.filter(result => result.outcome === 'correct').length, 3);
  assert.equal(round.answer('correct', 10000), false);
  assert.equal(round.resume(10000), false);
});

test('the clock expires exactly at the deadline and rejects a late answer', () => {
  const round = makeRound({ duration: 2 });
  round.start(500);
  assert.ok(Math.abs(round.remaining(2499) - 0.001) < 1e-9);
  assert.equal(round.answer('correct', 2500), false);
  assert.equal(round.status, 'finished');
  assert.equal(round.reason, 'time');
  assert.equal(round.remaining(999999), 0);
  assert.deepEqual(round.results, []);
});

test('update catches a long browser suspension without relying on timer tick count', () => {
  const round = makeRound();
  round.start(0);
  assert.equal(round.update(10), false);
  assert.equal(round.update(120000), true);
  assert.equal(round.status, 'finished');
  assert.equal(round.reason, 'time');
  assert.equal(round.update(120001), false);
});

test('pausing preserves fractional time and excludes time spent paused', () => {
  const round = makeRound({ duration: 10 });
  round.start(1000);
  assert.equal(round.pause(3250), true);
  assert.equal(round.status, 'paused');
  assert.equal(round.remaining(100000), 7.75);
  assert.equal(round.answer('correct', 100000), false);
  assert.equal(round.pause(100000), false);
  assert.equal(round.resume(100000), true);
  assert.equal(round.remaining(102500), 5.25);
  assert.equal(round.pause(102500), true);
  assert.equal(round.remaining(500000), 5.25);
  assert.equal(round.resume(500000), true);
  round.update(505250);
  assert.equal(round.reason, 'time');
});

test('a pause at the deadline ends the round instead of keeping it alive', () => {
  const round = makeRound({ duration: 1 });
  round.start(0);
  assert.equal(round.pause(1000), false);
  assert.equal(round.reason, 'time');
});

test('manual finish records remaining time, preserves answers and cannot be repeated', () => {
  const round = makeRound();
  round.start(0);
  round.answer('correct', 1000);
  assert.equal(round.finish(3500), true);
  assert.equal(round.reason, 'stopped');
  assert.equal(round.remaining(10000), 56.5);
  assert.equal(round.results.length, 1);
  assert.equal(round.finish(5000), false);
  round.results.push({ outcome: 'correct' });
  const results = round.results;
  results[0].outcome = 'pass';
  assert.equal(round.results.length, 1);
  assert.equal(round.results[0].outcome, 'correct');
});

test('expiry takes precedence when stop and timeout happen together', () => {
  const round = makeRound({ duration: 1 });
  round.start(0);
  round.finish(1500);
  assert.equal(round.reason, 'time');
});

test('invalid input fails explicitly, including duplicate cards and invalid random values', () => {
  assert.throws(() => new Round(), TypeError);
  assert.throws(() => makeRound({ actors: [] }), TypeError);
  assert.throws(() => makeRound({ actors: [actors[0], actors[0]] }), TypeError);
  assert.throws(() => makeRound({ actors: [{ id: '', name: 'Név' }] }), TypeError);
  for (const duration of [0, -1, NaN, Infinity, '60']) {
    assert.throws(() => makeRound({ duration }), RangeError);
  }
  assert.throws(() => makeRound({ random: () => 1 }), RangeError);
  assert.throws(() => makeRound({ random: 0 }), TypeError);
  const round = makeRound();
  assert.throws(() => round.start(NaN), TypeError);
  assert.throws(() => round.answer('unknown', 0), TypeError);
  assert.throws(() => round.finish(0, 'unknown'), TypeError);
});

test('a backwards clock does not add time to the running round', () => {
  const round = makeRound();
  round.start(1000);
  round.update(2000);
  round.update(1500);
  assert.equal(round.remaining(1500), 59);
  assert.equal(round.remaining(3000), 58);
});

test('screen-normal tilt detection works in either landscape direction and portrait', () => {
  assert.equal(tiltState({ beta: 0, gamma: 90 }), 'neutral');
  assert.equal(tiltState({ beta: 0, gamma: -90 }), 'neutral');
  assert.equal(tiltState({ beta: 90, gamma: 0 }), 'neutral');
  assert.equal(tiltState({ beta: 0, gamma: 0 }), 'correct');
  assert.equal(tiltState({ beta: 180, gamma: 0 }), 'pass');
  assert.equal(tiltState({ beta: -180, gamma: 0 }), 'pass');
  assert.equal(tiltState({ beta: 60, gamma: 0 }), null);
  assert.equal(tiltState({ beta: null, gamma: 0 }), null);
  assert.equal(tiltState({ beta: NaN, gamma: 0 }), null);
  assert.equal(tiltState({ beta: Infinity, gamma: 0 }), null);
  assert.equal(tiltState(), null);
});
