export function money(amount, currency) {
  if (!Number.isSafeInteger(amount)) throw new TypeError('Money amount must be a safe integer of minor units');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new TypeError('Currency must be a three-letter upper-case code');
  return Object.freeze({ amount, currency });
}

function same(a, b) {
  if (a.currency !== b.currency) throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a, b) { same(a, b); return money(a.amount + b.amount, a.currency); }
export function subtract(a, b) { same(a, b); return money(a.amount - b.amount, a.currency); }

export function multiply(m, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError('quantity must be a non-negative integer');
  return money(m.amount * quantity, m.currency);
}

/** Half-to-even rounding of numerator / denominator (denominator > 0) with integer arithmetic. */
function divideHalfEven(numerator, denominator) {
  const n = BigInt(numerator), d = BigInt(denominator);
  let q = n / d, r = n % d; // truncates toward zero
  if (r < 0n) { q -= 1n; r += d; } // floor division, 0 <= r < d
  const twice = 2n * r;
  if (twice > d || (twice === d && q % 2n !== 0n)) q += 1n;
  return Number(q);
}

export function percentage(m, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('percent must be an integer from 0 to 100');
  return money(divideHalfEven(m.amount * percent, 100), m.currency);
}

export function allocate(m, weights) {
  if (m.amount < 0) throw new RangeError('Cannot allocate a negative amount');
  if (!Array.isArray(weights) || !weights.length || !weights.every(w => Number.isInteger(w) && w >= 0)) throw new RangeError('weights must be non-negative integers');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new RangeError('weights must have a positive sum');
  const total = BigInt(m.amount), s = BigInt(sum);
  const parts = weights.map(w => total * BigInt(w) / s);
  const remainders = weights.map((w, index) => ({ index, rest: total * BigInt(w) % s }));
  let left = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const { index } of remainders) { if (left <= 0n) break; parts[index] += 1n; left -= 1n; }
  return parts.map(p => money(Number(p), m.currency));
}

export function isZero(m) { return m.amount === 0; }

export function compare(a, b) { same(a, b); return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1; }

export function format(m) {
  const abs = Math.abs(m.amount);
  const units = Math.floor(abs / 100), cents = String(abs % 100).padStart(2, '0');
  return `${m.amount < 0 ? '-' : ''}${units}.${cents} ${m.currency}`;
}
