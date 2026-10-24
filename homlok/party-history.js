const STORAGE_KEY = 'homlok-party-v1';
const EXCLUSIONS_KEY = 'homlok-exclusions-v1';

function cardId(card) {
  if (!card || typeof card.id !== 'string' || !card.id.trim()) {
    throw new TypeError('Minden kártyához nem üres szöveges azonosító szükséges.');
  }
  return card.id;
}

/** Shared, persistent card history for every category in one party. */
export class PartyHistory {
  #known;
  #seen = new Set();
  #excluded = new Set();
  #storage;

  constructor({ cards, storage = null } = {}) {
    if (!Array.isArray(cards)) throw new TypeError('A kártyákat tömbként kell megadni.');
    this.#known = new Set(cards.map(cardId));
    if (this.#known.size !== cards.length) throw new TypeError('A kártyaazonosítók legyenek egyediek.');
    this.#storage = storage;
    this.#seen = this.#load(STORAGE_KEY, 'seen');
    this.#excluded = this.#load(EXCLUSIONS_KEY, 'excluded');
  }

  get usedCount() { return this.#seen.size; }
  get totalCount() { return this.#known.size; }
  get excludedCount() { return this.#excluded.size; }
  get excludedIds() { return [...this.#excluded]; }
  get availableCount() { return this.#known.size - this.#excluded.size; }

  hasSeen(id) { return this.#seen.has(id); }
  isExcluded(id) { return this.#excluded.has(id); }

  remaining(cards) {
    if (!Array.isArray(cards)) throw new TypeError('A kártyákat tömbként kell megadni.');
    const added = new Set();
    return cards.filter(card => {
      const id = cardId(card);
      if (!this.#known.has(id) || this.#seen.has(id) || this.#excluded.has(id) || added.has(id)) return false;
      added.add(id);
      return true;
    });
  }

  markSeen(id) {
    if (!this.#known.has(id) || this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.#persist(STORAGE_KEY, 'seen', this.#seen);
    return true;
  }

  exclude(id) {
    if (!this.#known.has(id) || this.#excluded.has(id)) return false;
    this.#excluded.add(id);
    this.#persist(EXCLUSIONS_KEY, 'excluded', this.#excluded);
    return true;
  }

  restore(id) {
    if (!this.#excluded.delete(id)) return false;
    this.#persist(EXCLUSIONS_KEY, 'excluded', this.#excluded);
    return true;
  }

  /** Start a new party while preserving permanent card preferences. */
  reset() {
    this.#seen.clear();
    this.#persist(STORAGE_KEY, 'seen', this.#seen);
  }

  #load(key, field) {
    try {
      const raw = this.#storage?.getItem(key);
      if (raw == null) return new Set();
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved[field])) return new Set();
      const ids = new Set(saved[field].filter(id => typeof id === 'string' && this.#known.has(id)));
      // Normalize duplicates and remove cards no longer present in the catalog.
      this.#persist(key, field, ids);
      return ids;
    } catch {
      // Load each key independently so one malformed save cannot hide the other.
      return new Set();
    }
  }

  #persist(key, field, ids) {
    try {
      this.#storage?.setItem(key, JSON.stringify({ version: 1, [field]: [...ids] }));
    } catch {
      // Keep the in-memory history even when persistence is unavailable.
    }
  }
}
