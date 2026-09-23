import { add, percentage } from './money.mjs';

const CATEGORIES = ['standard', 'reduced', 'exempt'];

export function computeTax(lines, rates) {
  if (!rates || !CATEGORIES.every(c => Number.isInteger(rates[c]) && rates[c] >= 0 && rates[c] <= 100)) throw new RangeError('Invalid tax rates');
  const byCategory = {};
  const out = lines.map(line => {
    const tax = percentage(line.net, rates[line.taxCategory]);
    const total = add(line.net, tax);
    const entry = byCategory[line.taxCategory];
    byCategory[line.taxCategory] = entry ? { net: add(entry.net, line.net), tax: add(entry.tax, tax) } : { net: line.net, tax };
    return { ...line, tax, total };
  });
  return { lines: out, byCategory };
}
