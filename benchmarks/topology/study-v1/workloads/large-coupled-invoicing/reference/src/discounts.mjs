import { add, allocate, compare, money, multiply, percentage, subtract } from './money.mjs';

const LINE_RULES = ['percent_off_sku', 'buy_x_get_y'];
const ORDER_RULES = ['order_percent', 'order_fixed'];
const isPercent = p => Number.isInteger(p) && p >= 0 && p <= 100;
const isPositive = n => Number.isInteger(n) && n > 0;
const isMoney = (m, currency) => m && Number.isSafeInteger(m.amount) && (currency === null || m.currency === currency);

function validate(rules, currency) {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || rule.id === '' || ids.has(rule.id)) throw new TypeError('Rules need unique non-empty ids');
    ids.add(rule.id);
    const ok = {
      percent_off_sku: () => typeof rule.sku === 'string' && isPercent(rule.percent),
      buy_x_get_y: () => typeof rule.sku === 'string' && isPositive(rule.buy) && isPositive(rule.get),
      order_percent: () => isPercent(rule.percent) && isMoney(rule.minSubtotal, currency),
      order_fixed: () => isMoney(rule.amount, currency) && rule.amount.amount >= 0 && isMoney(rule.minSubtotal, currency),
    }[rule.type];
    if (!ok || !ok()) throw new TypeError(`Invalid rule ${rule.id}`);
  }
}

export function applyDiscounts(lines, rules) {
  const currency = lines.length ? lines[0].subtotal.currency : null;
  validate(rules, currency);
  const out = lines.map(line => ({ ...line, discount: money(0, line.subtotal.currency) }));
  const applied = [];
  const record = (ruleId, amount) => { if (amount > 0) applied.push({ ruleId, amount: money(amount, currency) }); };
  const ordered = [...rules.filter(r => LINE_RULES.includes(r.type)), ...rules.filter(r => ORDER_RULES.includes(r.type))];
  for (const rule of ordered) {
    if (LINE_RULES.includes(rule.type)) {
      const line = out.find(l => l.sku === rule.sku);
      if (!line) continue;
      const wanted = rule.type === 'percent_off_sku' ? percentage(line.subtotal, rule.percent)
        : multiply(line.unitPrice, Math.floor(line.quantity / (rule.buy + rule.get)) * rule.get);
      const room = line.subtotal.amount - line.discount.amount;
      const amount = Math.min(wanted.amount, room);
      line.discount = add(line.discount, money(amount, currency));
      record(rule.id, amount);
      continue;
    }
    if (!out.length) continue;
    const nets = out.map(l => l.subtotal.amount - l.discount.amount);
    const netTotal = money(nets.reduce((a, b) => a + b, 0), currency);
    if (netTotal.amount === 0 || compare(netTotal, rule.minSubtotal) < 0) continue;
    const discount = rule.type === 'order_percent' ? percentage(netTotal, rule.percent)
      : money(Math.min(rule.amount.amount, netTotal.amount), currency);
    allocate(discount, nets).forEach((part, i) => { out[i].discount = add(out[i].discount, part); });
    record(rule.id, discount.amount);
  }
  return { lines: out.map(line => ({ ...line, net: subtract(line.subtotal, line.discount) })), applied };
}
