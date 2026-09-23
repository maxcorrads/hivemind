const SYMBOLS = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const CANONICAL = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError('toRoman accepts integers from 1 to 3999');
  let out = '';
  for (const [value, symbol] of SYMBOLS) while (n >= value) { out += symbol; n -= value; }
  return out;
}

export function fromRoman(text) {
  if (typeof text !== 'string') throw new TypeError('fromRoman expects a string');
  if (text === '' || !CANONICAL.test(text)) throw new SyntaxError(`Not a canonical Roman numeral: ${text}`);
  let total = 0, i = 0;
  for (const [value, symbol] of SYMBOLS) while (text.startsWith(symbol, i)) { total += value; i += symbol.length; }
  return total;
}
