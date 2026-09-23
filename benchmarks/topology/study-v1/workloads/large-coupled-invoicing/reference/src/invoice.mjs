import { createCart } from './cart.mjs';
import { applyDiscounts } from './discounts.mjs';
import { add, format, money } from './money.mjs';
import { computeTax } from './tax.mjs';

export function createInvoice({ catalog, items, rules = [], rates }) {
  const cart = createCart(catalog);
  for (const item of items) cart.add(item.sku, item.quantity);
  const discounted = applyDiscounts(cart.lines(), rules);
  const taxed = computeTax(discounted.lines, rates);
  const sum = field => taxed.lines.reduce((total, line) => add(total, line[field]), money(0, catalog.currency));
  return {
    currency: catalog.currency,
    lines: taxed.lines,
    subtotal: sum('subtotal'),
    discountTotal: sum('discount'),
    netTotal: sum('net'),
    taxTotal: sum('tax'),
    grandTotal: sum('total'),
    applied: discounted.applied,
    taxByCategory: taxed.byCategory,
  };
}

export function renderInvoice(invoice) {
  return [
    ...invoice.lines.map(line => `${line.sku} x${line.quantity} ${format(line.total)}`),
    `Subtotal: ${format(invoice.subtotal)}`,
    `Discounts: ${format(invoice.discountTotal)}`,
    `Tax: ${format(invoice.taxTotal)}`,
    `Total: ${format(invoice.grandTotal)}`,
  ].join('\n');
}
