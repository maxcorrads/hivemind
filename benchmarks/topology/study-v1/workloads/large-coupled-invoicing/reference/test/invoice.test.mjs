import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog } from '../src/catalog.mjs';
import { createInvoice, renderInvoice } from '../src/invoice.mjs';
import { money } from '../src/money.mjs';

test('renders the documented example', () => {
  const catalog = createCatalog([
    { sku: 'PEN', name: 'Pen', price: money(250, 'EUR'), taxCategory: 'standard' },
    { sku: 'BOOK', name: 'Book', price: money(1999, 'EUR'), taxCategory: 'reduced' },
  ]);
  const invoice = createInvoice({ catalog, items: [{ sku: 'PEN', quantity: 3 }, { sku: 'BOOK', quantity: 1 }],
    rules: [{ id: 'pens', type: 'buy_x_get_y', sku: 'PEN', buy: 2, get: 1 }], rates: { standard: 22, reduced: 4, exempt: 0 } });
  assert.equal(renderInvoice(invoice), [
    'PEN x3 6.10 EUR', 'BOOK x1 20.79 EUR', 'Subtotal: 27.49 EUR', 'Discounts: 2.50 EUR', 'Tax: 1.90 EUR', 'Total: 26.89 EUR',
  ].join('\n'));
});
