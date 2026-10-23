const STORAGE_KEY = 'homlok-party-v1';

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
  #storage;

  constructor({ cards, storage = null } = {}) {
    if (!Array.isArray(cards)) throw new TypeError('A kártyákat tömbként kell megadni.');
    this.#known = new Set(cards.map(cardId));
    if (this.#known.size !== cards.length) throw new TypeError('A kártyaazonosítók legyenek egyediek.');
    this.#storage = storage;

    try {
      const raw = this.#storage?.getItem(STORAGE_KEY);
      if (raw == null) return;
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved.seen)) return;
      this.#seen = new Set(saved.seen.filter(id => typeof id === 'string' && this.#known.has(id)));
      // Normalize duplicates and remove cards no longer present in the catalog.
      this.#persist();
    } catch {
      // Private browsing, full storage and malformed saves never block a game.
    }
  }

  get usedCount() { return this.#seen.size; }
  get totalCount() { return this.#known.size; }

  hasSeen(id) { return this.#seen.has(id); }

  remaining(cards) {
    if (!Array.isArray(cards)) throw new TypeError('A kártyákat tömbként kell megadni.');
    const added = new Set();
    return cards.filter(card => {
      const id = cardId(card);
      if (!this.#known.has(id) || this.#seen.has(id) || added.has(id)) return false;
      added.add(id);
      return true;
    });
  }

  markSeen(id) {
    if (!this.#known.has(id) || this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.#persist();
    return true;
  }

  reset() {
    this.#seen.clear();
    this.#persist();
  }

  #persist() {
    try {
      this.#storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, seen: [...this.#seen] }));
    } catch {
      // Keep the in-memory history even when persistence is unavailable.
    }
  }
}
