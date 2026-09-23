export class TokenBucket {
  #capacity;
  #rate;
  #now;
  #tokens;
  #last;

  constructor({ capacity, refillPerSecond, now = Date.now } = {}) {
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) throw new RangeError('capacity must be a finite number > 0');
    if (typeof refillPerSecond !== 'number' || !Number.isFinite(refillPerSecond) || refillPerSecond < 0) throw new RangeError('refillPerSecond must be a finite number >= 0');
    this.#capacity = capacity;
    this.#rate = refillPerSecond;
    this.#now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  #refill() {
    const t = this.#now();
    const elapsed = Math.max(0, t - this.#last);
    this.#last = t;
    this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsed * this.#rate) / 1000);
  }

  #check(count) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0 || count > this.#capacity) throw new RangeError('Invalid token count');
  }

  available() { this.#refill(); return this.#tokens; }

  tryRemove(count = 1) {
    this.#check(count);
    this.#refill();
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  msUntilAvailable(count = 1) {
    this.#check(count);
    this.#refill();
    if (this.#tokens >= count) return 0;
    if (this.#rate === 0) return Infinity;
    return Math.ceil(((count - this.#tokens) * 1000) / this.#rate);
  }
}
