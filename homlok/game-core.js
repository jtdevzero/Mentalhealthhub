/** Pure round logic. Timestamps are milliseconds; durations are seconds. */

const nowByDefault = () => globalThis.performance?.now?.() ?? Date.now();

function validTime(now) {
  if (!Number.isFinite(now)) throw new TypeError('Az időbélyegnek véges számnak kell lennie.');
  return now;
}

export class Round {
  #actors;
  #duration;
  #left;
  #anchor = null;
  #status = 'ready';
  #reason = null;
  #index = 0;
  #results = [];

  constructor({ actors, duration = 60, random = Math.random } = {}) {
    if (!Array.isArray(actors) || actors.length === 0) {
      throw new TypeError('A körhöz legalább egy színész szükséges.');
    }
    const ids = new Set();
    for (const actor of actors) {
      if (!actor || typeof actor.id !== 'string' || !actor.id.trim()
        || typeof actor.name !== 'string' || !actor.name.trim() || ids.has(actor.id)) {
        throw new TypeError('A színészeknek egyedi azonosítóval és névvel kell rendelkezniük.');
      }
      ids.add(actor.id);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new RangeError('A kör időtartamának pozitív, véges számnak kell lennie.');
    }
    if (typeof random !== 'function') throw new TypeError('Érvénytelen véletlenszám-generátor.');

    this.#duration = duration;
    this.#left = duration;
    this.#actors = actors.map(actor => Object.freeze({ ...actor }));
    for (let i = this.#actors.length - 1; i > 0; i -= 1) {
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError('A véletlenszám-generátor eredménye 0 és 1 közé essen.');
      }
      const j = Math.floor(value * (i + 1));
      [this.#actors[i], this.#actors[j]] = [this.#actors[j], this.#actors[i]];
    }
  }

  get status() { return this.#status; }
  get reason() { return this.#reason; }
  get current() { return this.#status === 'finished' ? null : this.#actors[this.#index]; }
  get results() { return this.#results.map(result => ({ ...result })); }
  get duration() { return this.#duration; }

  remaining(now = nowByDefault()) {
    validTime(now);
    if (this.#status !== 'playing') return this.#left;
    return Math.max(0, this.#left - Math.max(0, now - this.#anchor) / 1000);
  }

  start(now = nowByDefault()) {
    validTime(now);
    if (this.#status !== 'ready') return false;
    this.#anchor = now;
    this.#status = 'playing';
    return true;
  }

  update(now = nowByDefault()) {
    validTime(now);
    const previous = this.#status;
    this.#advance(now);
    return previous !== this.#status;
  }

  answer(outcome, now = nowByDefault()) {
    validTime(now);
    if (outcome !== 'correct' && outcome !== 'pass') {
      throw new TypeError('A válasz típusa correct vagy pass lehet.');
    }
    this.#advance(now);
    if (this.#status !== 'playing') return false;
    this.#results.push(Object.freeze({ actor: this.current, outcome }));
    this.#index += 1;
    if (this.#index === this.#actors.length) this.#end('exhausted');
    return true;
  }

  pause(now = nowByDefault()) {
    validTime(now);
    this.#advance(now);
    if (this.#status !== 'playing') return false;
    this.#status = 'paused';
    this.#anchor = null;
    return true;
  }

  resume(now = nowByDefault()) {
    validTime(now);
    if (this.#status !== 'paused') return false;
    this.#anchor = now;
    this.#status = 'playing';
    return true;
  }

  finish(now = nowByDefault(), reason = 'stopped') {
    validTime(now);
    if (!['stopped', 'time', 'exhausted'].includes(reason)) {
      throw new TypeError('Érvénytelen körlezárási ok.');
    }
    if (this.#status === 'finished') return false;
    this.#advance(now);
    // Expiry takes precedence over a simultaneous manual stop.
    if (this.#status !== 'finished') this.#end(reason);
    return true;
  }

  #advance(now) {
    if (this.#status !== 'playing') return;
    // A clock moving backwards must never add time to a round.
    if (now < this.#anchor) return;
    this.#left = Math.max(0, this.#left - (now - this.#anchor) / 1000);
    this.#anchor = now;
    if (this.#left === 0) this.#end('time');
  }

  #end(reason) {
    this.#status = 'finished';
    this.#reason = reason;
    this.#anchor = null;
  }
}

/**
 * The screen's normal is independent of portrait/landscape orientation.
 * Return through neutral before accepting another tilt in the UI.
 * null means missing sensor readings or the hysteresis dead zone.
 */
export function tiltState({ beta, gamma } = {}) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const radians = Math.PI / 180;
  const z = Math.cos(beta * radians) * Math.cos(gamma * radians);
  if (Math.abs(z) < 0.3) return 'neutral';
  if (z > 0.65) return 'correct';
  if (z < -0.65) return 'pass';
  return null;
}
