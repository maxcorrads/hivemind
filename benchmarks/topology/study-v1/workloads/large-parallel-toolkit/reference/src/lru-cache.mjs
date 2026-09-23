export class LRUCache {
  #map = new Map();
  #max;
  #onEvict;

  constructor({ maxEntries, onEvict } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
    if (onEvict !== undefined && typeof onEvict !== 'function') throw new TypeError('onEvict must be a function');
    this.#max = maxEntries;
    this.#onEvict = onEvict;
  }

  get size() { return this.#map.size; }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  peek(key) { return this.#map.get(key); }

  has(key) { return this.#map.has(key); }

  set(key, value) {
    const existed = this.#map.delete(key);
    this.#map.set(key, value);
    if (!existed && this.#map.size > this.#max) {
      const [oldestKey, oldestValue] = this.#map.entries().next().value;
      this.#map.delete(oldestKey);
      this.#onEvict?.(oldestKey, oldestValue);
    }
    return this;
  }

  delete(key) { return this.#map.delete(key); }

  clear() { this.#map.clear(); }

  keys() { return [...this.#map.keys()].reverse(); }
}
