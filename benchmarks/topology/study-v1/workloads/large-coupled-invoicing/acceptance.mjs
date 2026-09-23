// study-v1 acceptance: large-coupled-invoicing. Usage: node acceptance.mjs <workspace>
// Prints {"passed": boolean, "defects": integer} on the last stdout line and exits 0 (non-zero only on a harness bug).
// Self-contained on purpose: the runner copies this file without its extension, so it uses no static imports and
// works as either module type. Hidden tests are written to a temporary directory, never into the workspace.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { randomUUID } = process.getBuiltinModule('node:crypto');

const REQUIRED_TEST_FILES = ['test/invoice.test.mjs'];
const HIDDEN_TIMEOUT_MS = 40_000, AGENT_TESTS_TIMEOUT_MS = 40_000, CASE_TIMEOUT_MS = 5_000;

// Serialized with Function#toString and run in a child process: keep it free of outer references.
async function hiddenSuite(workspace, resultFile, caseTimeoutMs) {
  const { appendFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const assert = (await import('node:assert/strict')).default;
  const modules = { money: 'src/money.mjs', catalog: 'src/catalog.mjs', cart: 'src/cart.mjs', discounts: 'src/discounts.mjs', tax: 'src/tax.mjs', invoice: 'src/invoice.mjs' };
  const cases = [];
  const test = (name, needs, fn) => cases.push({ name, needs, fn });

  // Inputs are built as plain frozen objects so each module is checked against the shared shape, not only its own helpers.
  const M = (amount, currency = 'EUR') => Object.freeze({ amount, currency });
  const L = (sku, quantity, unit, taxCategory = 'standard') => ({ sku, name: sku.toLowerCase(), quantity, unitPrice: M(unit), taxCategory, subtotal: M(unit * quantity) });
  const D = (sku, taxCategory, net) => ({ ...L(sku, 1, net, taxCategory), discount: M(0), net: M(net) });
  const RATES = { standard: 22, reduced: 4, exempt: 0 };
  const PRODUCTS = [
    { sku: 'PEN', name: 'Pen', price: M(250), taxCategory: 'standard' },
    { sku: 'BOOK', name: 'Book', price: M(1999), taxCategory: 'reduced' },
    { sku: 'GIFT', name: 'Gift card', price: M(1500), taxCategory: 'exempt' },
    { sku: 'MUG', name: 'Mug', price: M(899), taxCategory: 'standard' },
  ];
  const isPlainError = err => err instanceof Error && !(err instanceof TypeError) && !(err instanceof RangeError);
  const amounts = list => list.map(m => m.amount);

  // money
  test('money-construct-and-validate', ['money'], ({ money: m }) => {
    const value = m.money(5, 'EUR');
    assert.deepEqual(value, { amount: 5, currency: 'EUR' }); assert.equal(Object.isFrozen(value), true);
    assert.deepEqual(m.money(-12, 'USD'), { amount: -12, currency: 'USD' });
    for (const amount of [1.5, NaN, '5', 2 ** 53, Infinity]) assert.throws(() => m.money(amount, 'EUR'), TypeError, String(amount));
    for (const currency of ['eur', 'EU', 'EURO', 5, undefined]) assert.throws(() => m.money(1, currency), TypeError, String(currency));
  });
  test('money-add-subtract', ['money'], ({ money: m }) => {
    assert.deepEqual(m.add(M(150), M(-50)), M(100)); assert.deepEqual(m.subtract(M(100), M(250)), M(-150));
    assert.equal(Object.isFrozen(m.add(M(1), M(2))), true);
    assert.throws(() => m.add(M(1), M(1, 'USD')), TypeError); assert.throws(() => m.subtract(M(1), M(1, 'USD')), TypeError);
  });
  test('money-multiply', ['money'], ({ money: m }) => {
    assert.deepEqual(m.multiply(M(250), 3), M(750)); assert.deepEqual(m.multiply(M(250), 0), M(0));
    for (const q of [-1, 1.5, '2']) assert.throws(() => m.multiply(M(1), q), RangeError, String(q));
  });
  test('money-percentage-half-even', ['money'], ({ money: m }) => {
    const cases = [[1005, 10, 100], [1015, 10, 102], [1999, 15, 300], [250, 22, 55], [125, 50, 62], [375, 50, 188], [0, 22, 0], [1234, 100, 1234], [1234, 0, 0], [2697, 15, 405]];
    for (const [amount, percent, want] of cases) assert.deepEqual(m.percentage(M(amount), percent), M(want), `${amount}@${percent}`);
  });
  test('money-percentage-negative-and-validation', ['money'], ({ money: m }) => {
    const cases = [[-1005, 10, -100], [-1015, 10, -102], [-1999, 15, -300], [-125, 50, -62]];
    for (const [amount, percent, want] of cases) assert.deepEqual(m.percentage(M(amount), percent), M(want), `${amount}@${percent}`);
    for (const p of [101, -1, 2.5, '10']) assert.throws(() => m.percentage(M(100), p), RangeError, String(p));
  });
  test('money-allocate', ['money'], ({ money: m }) => {
    assert.deepEqual(amounts(m.allocate(M(100), [1, 1, 1])), [34, 33, 33]);
    assert.deepEqual(amounts(m.allocate(M(10), [3, 7])), [3, 7]);
    assert.deepEqual(amounts(m.allocate(M(5), [1, 2, 0, 2])), [1, 2, 0, 2]);
    assert.deepEqual(amounts(m.allocate(M(7), [2, 3, 5])), [1, 2, 4]);
    assert.deepEqual(amounts(m.allocate(M(3), [1, 1, 1, 1])), [1, 1, 1, 0]);
    assert.deepEqual(amounts(m.allocate(M(0), [1, 2])), [0, 0]);
    assert.deepEqual(m.allocate(M(3, 'USD'), [1, 2]), [M(1, 'USD'), M(2, 'USD')]);
  });
  test('money-allocate-invalid', ['money'], ({ money: m }) => {
    assert.throws(() => m.allocate(M(-1), [1]), RangeError);
    for (const w of [[], [0, 0], [-1, 2], [1.5]]) assert.throws(() => m.allocate(M(10), w), RangeError, JSON.stringify(w));
  });
  test('money-compare-iszero-format', ['money'], ({ money: m }) => {
    assert.equal(m.compare(M(1), M(2)), -1); assert.equal(m.compare(M(2), M(2)), 0); assert.equal(m.compare(M(3), M(2)), 1);
    assert.throws(() => m.compare(M(1), M(1, 'USD')), TypeError);
    assert.equal(m.isZero(M(0)), true); assert.equal(m.isZero(M(-1)), false);
    const formats = [[1234, 'EUR', '12.34 EUR'], [-5, 'EUR', '-0.05 EUR'], [0, 'EUR', '0.00 EUR'], [100000, 'EUR', '1000.00 EUR'], [-12345, 'USD', '-123.45 USD'], [7, 'EUR', '0.07 EUR']];
    for (const [amount, currency, text] of formats) assert.equal(m.format(M(amount, currency)), text);
  });
  // catalog
  test('catalog-get-has', ['catalog'], ({ catalog: c }) => {
    const catalog = c.createCatalog(PRODUCTS);
    assert.equal(catalog.currency, 'EUR');
    assert.deepEqual(catalog.get('PEN'), { sku: 'PEN', name: 'Pen', price: M(250), taxCategory: 'standard' });
    assert.equal(catalog.has('MUG'), true); assert.equal(catalog.has('NOPE'), false);
    assert.throws(() => catalog.get('NOPE'), RangeError);
  });
  test('catalog-validation', ['catalog'], ({ catalog: c }) => {
    const pen = PRODUCTS[0];
    assert.throws(() => c.createCatalog([]), TypeError); assert.throws(() => c.createCatalog('PEN'), TypeError);
    for (const bad of [{ ...pen, name: '' }, { ...pen, sku: 5 }, { ...pen, taxCategory: 'luxury' }, { ...pen, price: M(-1) }, { ...pen, price: 250 }]) {
      assert.throws(() => c.createCatalog([bad]), TypeError, JSON.stringify(bad));
    }
    assert.throws(() => c.createCatalog([pen, { ...pen, name: 'Other pen' }]), isPlainError);
    assert.throws(() => c.createCatalog([pen, { ...PRODUCTS[1], price: M(1999, 'USD') }]), TypeError);
  });
  // cart
  test('cart-add-and-lines', ['catalog', 'cart'], ({ catalog: c, cart: k }) => {
    const cart = k.createCart(c.createCatalog(PRODUCTS));
    assert.equal(cart.add('BOOK'), cart);
    cart.add('PEN', 2).add('BOOK', 2);
    assert.deepEqual(cart.lines(), [
      { sku: 'BOOK', name: 'Book', quantity: 3, unitPrice: M(1999), taxCategory: 'reduced', subtotal: M(5997) },
      { sku: 'PEN', name: 'Pen', quantity: 2, unitPrice: M(250), taxCategory: 'standard', subtotal: M(500) },
    ]);
  });
  test('cart-set-quantity-and-remove', ['catalog', 'cart'], ({ catalog: c, cart: k }) => {
    const cart = k.createCart(c.createCatalog(PRODUCTS));
    cart.add('PEN').add('BOOK').add('MUG');
    assert.equal(cart.setQuantity('PEN', 5), cart);
    assert.deepEqual(cart.lines().map(l => [l.sku, l.quantity]), [['PEN', 5], ['BOOK', 1], ['MUG', 1]]);
    cart.setQuantity('PEN', 0);
    assert.equal(cart.remove('BOOK'), true); assert.equal(cart.remove('BOOK'), false);
    assert.deepEqual(cart.lines().map(l => l.sku), ['MUG']);
    assert.throws(() => cart.setQuantity('NOPE', 1), RangeError); assert.throws(() => cart.setQuantity('PEN', 1), RangeError);
    assert.throws(() => cart.setQuantity('MUG', -1), RangeError); assert.throws(() => cart.setQuantity('MUG', 1.5), RangeError);
  });
  test('cart-validation', ['catalog', 'cart'], ({ catalog: c, cart: k }) => {
    const cart = k.createCart(c.createCatalog(PRODUCTS));
    assert.throws(() => cart.add('NOPE'), RangeError);
    for (const q of [0, -1, 1.5, '2']) assert.throws(() => cart.add('PEN', q), RangeError, String(q));
    assert.deepEqual(cart.lines(), []);
  });
  test('cart-subtotal-and-copies', ['catalog', 'cart'], ({ catalog: c, cart: k }) => {
    const cart = k.createCart(c.createCatalog(PRODUCTS));
    assert.deepEqual(cart.subtotal(), M(0));
    cart.add('PEN', 3).add('MUG', 2);
    assert.deepEqual(cart.subtotal(), M(750 + 1798));
    const lines = cart.lines(); lines.pop();
    assert.equal(cart.lines().length, 2);
  });
  // discounts
  test('discounts-none', ['discounts'], ({ discounts: d }) => {
    assert.deepEqual(d.applyDiscounts([L('A', 2, 100)], []), { lines: [{ ...L('A', 2, 100), discount: M(0), net: M(200) }], applied: [] });
  });
  test('discounts-percent-off-sku', ['discounts'], ({ discounts: d }) => {
    const result = d.applyDiscounts([L('A', 3, 333), L('B', 1, 1000)], [{ id: 'p', type: 'percent_off_sku', sku: 'A', percent: 15 }, { id: 'z', type: 'percent_off_sku', sku: 'Z', percent: 50 }]);
    assert.deepEqual(result.lines, [{ ...L('A', 3, 333), discount: M(150), net: M(849) }, { ...L('B', 1, 1000), discount: M(0), net: M(1000) }]);
    assert.deepEqual(result.applied, [{ ruleId: 'p', amount: M(150) }]);
  });
  test('discounts-buy-x-get-y', ['discounts'], ({ discounts: d }) => {
    const rule = { id: 'b', type: 'buy_x_get_y', sku: 'A', buy: 2, get: 1 };
    assert.deepEqual(d.applyDiscounts([L('A', 7, 100)], [rule]).lines[0].discount, M(200));
    assert.deepEqual(d.applyDiscounts([L('A', 2, 100)], [rule]), { lines: [{ ...L('A', 2, 100), discount: M(0), net: M(200) }], applied: [] });
  });
  test('discounts-line-cap', ['discounts'], ({ discounts: d }) => {
    const result = d.applyDiscounts([L('A', 1, 1000)], [{ id: 'a', type: 'percent_off_sku', sku: 'A', percent: 60 }, { id: 'b', type: 'percent_off_sku', sku: 'A', percent: 60 }]);
    assert.deepEqual(result.lines[0].discount, M(1000)); assert.deepEqual(result.lines[0].net, M(0));
    assert.deepEqual(result.applied, [{ ruleId: 'a', amount: M(600) }, { ruleId: 'b', amount: M(400) }]);
  });
  test('discounts-order-percent-after-line-rules', ['discounts'], ({ discounts: d }) => {
    const rules = [{ id: 'o', type: 'order_percent', percent: 10, minSubtotal: M(1000) }, { id: 'l', type: 'percent_off_sku', sku: 'A', percent: 50 }];
    const result = d.applyDiscounts([L('A', 1, 1000), L('B', 1, 333), L('C', 1, 167)], rules);
    assert.deepEqual(result.lines.map(l => [l.discount.amount, l.net.amount]), [[550, 450], [33, 300], [17, 150]]);
    assert.deepEqual(result.applied, [{ ruleId: 'l', amount: M(500) }, { ruleId: 'o', amount: M(100) }]);
  });
  test('discounts-order-min-subtotal', ['discounts'], ({ discounts: d }) => {
    const result = d.applyDiscounts([L('A', 1, 999)], [{ id: 'o', type: 'order_percent', percent: 10, minSubtotal: M(1000) }, { id: 'f', type: 'order_fixed', amount: M(100), minSubtotal: M(1000) }]);
    assert.deepEqual(result, { lines: [{ ...L('A', 1, 999), discount: M(0), net: M(999) }], applied: [] });
  });
  test('discounts-order-fixed', ['discounts'], ({ discounts: d }) => {
    const all = d.applyDiscounts([L('A', 1, 300), L('B', 1, 100)], [{ id: 'f', type: 'order_fixed', amount: M(1000), minSubtotal: M(0) }]);
    assert.deepEqual(all.lines.map(l => l.net.amount), [0, 0]); assert.deepEqual(all.applied, [{ ruleId: 'f', amount: M(400) }]);
    const some = d.applyDiscounts([L('A', 1, 300), L('B', 1, 100)], [{ id: 'f', type: 'order_fixed', amount: M(50), minSubtotal: M(0) }]);
    assert.deepEqual(some.lines.map(l => l.discount.amount), [38, 12]);
  });
  test('discounts-sequential-order-rules', ['discounts'], ({ discounts: d }) => {
    const rules = [{ id: 'o1', type: 'order_percent', percent: 10, minSubtotal: M(0) }, { id: 'o2', type: 'order_fixed', amount: M(100), minSubtotal: M(1800) }];
    const result = d.applyDiscounts([L('A', 1, 1000), L('B', 1, 1000)], rules);
    assert.deepEqual(result.lines.map(l => l.discount.amount), [150, 150]);
    assert.deepEqual(result.applied, [{ ruleId: 'o1', amount: M(200) }, { ruleId: 'o2', amount: M(100) }]);
  });
  test('discounts-validation', ['discounts'], ({ discounts: d }) => {
    const lines = [L('A', 1, 100)];
    const bad = [[{ id: 'x', type: 'mystery' }], [{ id: 'p', type: 'percent_off_sku', sku: 'A', percent: 5 }, { id: 'p', type: 'percent_off_sku', sku: 'A', percent: 5 }],
      [{ id: 'p', type: 'percent_off_sku', sku: 'A', percent: 101 }], [{ id: 'p', type: 'percent_off_sku', sku: 'A', percent: 1.5 }],
      [{ id: 'b', type: 'buy_x_get_y', sku: 'A', buy: 0, get: 1 }], [{ type: 'percent_off_sku', sku: 'A', percent: 5 }],
      [{ id: 'o', type: 'order_percent', percent: 10, minSubtotal: M(0, 'USD') }], [{ id: 'f', type: 'order_fixed', amount: M(5, 'USD'), minSubtotal: M(0) }]];
    for (const rules of bad) assert.throws(() => d.applyDiscounts(lines, rules), TypeError, JSON.stringify(rules));
  });
  test('discounts-no-mutation-and-shape', ['discounts'], ({ discounts: d }) => {
    const lines = [L('A', 4, 250), L('B', 1, 100)];
    const before = JSON.stringify(lines);
    const result = d.applyDiscounts(lines, [{ id: 'b', type: 'buy_x_get_y', sku: 'A', buy: 3, get: 1 }, { id: 'o', type: 'order_percent', percent: 5, minSubtotal: M(0) }]);
    assert.equal(JSON.stringify(lines), before);
    assert.deepEqual(Object.keys(result).sort(), ['applied', 'lines']);
    assert.deepEqual(Object.keys(result.lines[0]).sort(), ['discount', 'name', 'net', 'quantity', 'sku', 'subtotal', 'taxCategory', 'unitPrice']);
    assert.deepEqual(d.applyDiscounts([], [{ id: 'o', type: 'order_percent', percent: 10, minSubtotal: M(0) }]), { lines: [], applied: [] });
  });
  // tax
  test('tax-lines-and-categories', ['tax'], ({ tax: t }) => {
    const lines = [D('A', 'standard', 1005), D('B', 'reduced', 1005), D('C', 'exempt', 999), D('E', 'standard', 250)];
    const result = t.computeTax(lines, { standard: 22, reduced: 10, exempt: 0 });
    assert.deepEqual(result.lines.map(l => [l.tax.amount, l.total.amount]), [[221, 1226], [100, 1105], [0, 999], [55, 305]]);
    assert.deepEqual(result.byCategory, { standard: { net: M(1255), tax: M(276) }, reduced: { net: M(1005), tax: M(100) }, exempt: { net: M(999), tax: M(0) } });
    assert.deepEqual(Object.keys(result.byCategory), ['standard', 'reduced', 'exempt']);
  });
  test('tax-category-order-and-shape', ['tax'], ({ tax: t }) => {
    const lines = [D('B', 'reduced', 100), D('A', 'standard', 100)];
    const before = JSON.stringify(lines);
    const result = t.computeTax(lines, RATES);
    assert.deepEqual(Object.keys(result.byCategory), ['reduced', 'standard']);
    assert.equal(JSON.stringify(lines), before);
    assert.deepEqual(Object.keys(result).sort(), ['byCategory', 'lines']);
    assert.deepEqual(result.lines[0], { ...lines[0], tax: M(4), total: M(104) });
  });
  test('tax-rate-validation', ['tax'], ({ tax: t }) => {
    for (const rates of [{ standard: 22, reduced: 4 }, { ...RATES, standard: 101 }, { ...RATES, reduced: 2.5 }, { ...RATES, exempt: '0' }, undefined]) {
      assert.throws(() => t.computeTax([D('A', 'standard', 100)], rates), RangeError, JSON.stringify(rates));
    }
  });
  // invoice (end to end)
  const example = (c, i) => i.createInvoice({ catalog: c.createCatalog(PRODUCTS.slice(0, 2)), items: [{ sku: 'PEN', quantity: 3 }, { sku: 'BOOK', quantity: 1 }],
    rules: [{ id: 'pens', type: 'buy_x_get_y', sku: 'PEN', buy: 2, get: 1 }], rates: RATES });
  test('invoice-documented-example', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    assert.deepEqual(example(c, i), {
      currency: 'EUR',
      lines: [
        { sku: 'PEN', name: 'Pen', quantity: 3, unitPrice: M(250), taxCategory: 'standard', subtotal: M(750), discount: M(250), net: M(500), tax: M(110), total: M(610) },
        { sku: 'BOOK', name: 'Book', quantity: 1, unitPrice: M(1999), taxCategory: 'reduced', subtotal: M(1999), discount: M(0), net: M(1999), tax: M(80), total: M(2079) },
      ],
      subtotal: M(2749), discountTotal: M(250), netTotal: M(2499), taxTotal: M(190), grandTotal: M(2689),
      applied: [{ ruleId: 'pens', amount: M(250) }],
      taxByCategory: { standard: { net: M(500), tax: M(110) }, reduced: { net: M(1999), tax: M(80) } },
    });
  });
  test('invoice-render-example', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    assert.equal(i.renderInvoice(example(c, i)), 'PEN x3 6.10 EUR\nBOOK x1 20.79 EUR\nSubtotal: 27.49 EUR\nDiscounts: 2.50 EUR\nTax: 1.90 EUR\nTotal: 26.89 EUR');
  });
  const complex = (c, i) => i.createInvoice({ catalog: c.createCatalog(PRODUCTS),
    items: [{ sku: 'PEN', quantity: 7 }, { sku: 'BOOK', quantity: 2 }, { sku: 'GIFT', quantity: 1 }, { sku: 'MUG', quantity: 3 }, { sku: 'PEN', quantity: 2 }],
    rules: [{ id: 'order10', type: 'order_percent', percent: 10, minSubtotal: M(5000) }, { id: 'pens', type: 'buy_x_get_y', sku: 'PEN', buy: 3, get: 1 },
      { id: 'mugs', type: 'percent_off_sku', sku: 'MUG', percent: 15 }, { id: 'fixed', type: 'order_fixed', amount: M(500), minSubtotal: M(0) }],
    rates: RATES });
  test('invoice-complex-lines', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    const inv = complex(c, i);
    assert.deepEqual(inv.lines.map(l => [l.sku, l.quantity, l.subtotal.amount, l.discount.amount, l.net.amount, l.tax.amount, l.total.amount]), [
      ['PEN', 9, 2250, 767, 1483, 326, 1809], ['BOOK', 2, 3998, 609, 3389, 136, 3525], ['GIFT', 1, 1500, 229, 1271, 0, 1271], ['MUG', 3, 2697, 754, 1943, 427, 2370]]);
  });
  test('invoice-complex-totals', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    const inv = complex(c, i);
    assert.deepEqual([inv.subtotal, inv.discountTotal, inv.netTotal, inv.taxTotal, inv.grandTotal], [M(10445), M(2359), M(8086), M(889), M(8975)]);
    assert.deepEqual(inv.applied, [{ ruleId: 'pens', amount: M(500) }, { ruleId: 'mugs', amount: M(405) }, { ruleId: 'order10', amount: M(954) }, { ruleId: 'fixed', amount: M(500) }]);
    assert.deepEqual(inv.taxByCategory, { standard: { net: M(3426), tax: M(753) }, reduced: { net: M(3389), tax: M(136) }, exempt: { net: M(1271), tax: M(0) } });
  });
  test('invoice-complex-render', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    assert.equal(i.renderInvoice(complex(c, i)), ['PEN x9 18.09 EUR', 'BOOK x2 35.25 EUR', 'GIFT x1 12.71 EUR', 'MUG x3 23.70 EUR',
      'Subtotal: 104.45 EUR', 'Discounts: 23.59 EUR', 'Tax: 8.89 EUR', 'Total: 89.75 EUR'].join('\n'));
  });
  test('invoice-empty', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    const inv = i.createInvoice({ catalog: c.createCatalog(PRODUCTS), items: [], rates: RATES });
    assert.deepEqual(inv, { currency: 'EUR', lines: [], subtotal: M(0), discountTotal: M(0), netTotal: M(0), taxTotal: M(0), grandTotal: M(0), applied: [], taxByCategory: {} });
    assert.equal(i.renderInvoice(inv), 'Subtotal: 0.00 EUR\nDiscounts: 0.00 EUR\nTax: 0.00 EUR\nTotal: 0.00 EUR');
  });
  test('invoice-errors-propagate', ['catalog', 'invoice'], ({ catalog: c, invoice: i }) => {
    const catalog = c.createCatalog(PRODUCTS);
    assert.throws(() => i.createInvoice({ catalog, items: [{ sku: 'NOPE', quantity: 1 }], rates: RATES }), RangeError);
    assert.throws(() => i.createInvoice({ catalog, items: [{ sku: 'PEN', quantity: 1 }], rules: [{ id: 'x', type: 'mystery' }], rates: RATES }), TypeError);
    assert.throws(() => i.createInvoice({ catalog, items: [{ sku: 'PEN', quantity: 1 }], rates: { standard: 22 } }), RangeError);
  });
  test('invoice-invariants', ['money', 'catalog', 'invoice'], ({ money: m, catalog: c, invoice: i }) => {
    let seed = 20260929;
    const rand = n => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const catalog = c.createCatalog(PRODUCTS);
    for (let round = 0; round < 25; round++) {
      const items = Array.from({ length: 1 + rand(6) }, () => ({ sku: PRODUCTS[rand(4)].sku, quantity: 1 + rand(9) }));
      const rules = [];
      if (rand(2)) rules.push({ id: 'r1', type: 'percent_off_sku', sku: PRODUCTS[rand(4)].sku, percent: rand(101) });
      if (rand(2)) rules.push({ id: 'r2', type: 'buy_x_get_y', sku: PRODUCTS[rand(4)].sku, buy: 1 + rand(3), get: 1 + rand(2) });
      if (rand(2)) rules.push({ id: 'r3', type: 'order_percent', percent: rand(51), minSubtotal: M(rand(8000)) });
      if (rand(2)) rules.push({ id: 'r4', type: 'order_fixed', amount: M(rand(3000)), minSubtotal: M(rand(8000)) });
      const rates = { standard: rand(30), reduced: rand(15), exempt: 0 };
      const inv = i.createInvoice({ catalog, items, rules, rates });
      const sum = key => inv.lines.reduce((s, l) => s + l[key].amount, 0);
      assert.equal(inv.grandTotal.amount, sum('total')); assert.equal(inv.subtotal.amount, sum('subtotal'));
      assert.equal(inv.netTotal.amount, inv.subtotal.amount - inv.discountTotal.amount);
      assert.equal(inv.grandTotal.amount, inv.netTotal.amount + inv.taxTotal.amount);
      assert.equal(inv.discountTotal.amount, inv.applied.reduce((s, a) => s + a.amount.amount, 0));
      for (const l of inv.lines) {
        assert.ok(l.discount.amount >= 0 && l.discount.amount <= l.subtotal.amount);
        assert.deepEqual(l.tax, m.percentage(l.net, rates[l.taxCategory]));
      }
    }
  });

  // Synchronous file appends survive process.exit (and a workspace module that exits early).
  const say = line => appendFileSync(resultFile, `${line}\n`);
  say(`TOTAL ${cases.length}`);
  const loaded = {};
  for (const [key, rel] of Object.entries(modules)) {
    try { loaded[key] = await import(pathToFileURL(join(workspace, rel)).href); } catch { loaded[key] = null; }
  }
  for (const c of cases) {
    let ok = false;
    if (c.needs.every(key => loaded[key])) {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(() => c.fn(loaded)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('case timeout')), caseTimeoutMs); })]);
        ok = true;
      } catch { ok = false; } finally { clearTimeout(timer); }
    }
    say(`${ok ? 'PASS' : 'FAIL'} ${c.name}`);
  }
  say('DONE');
  process.exit(0);
}

function listTests(workspace) {
  const dir = path.join(workspace, 'test'), out = [];
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(abs, e.name), `${rel}/${e.name}`);
      else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(`${rel}/${e.name}`);
    }
  };
  walk(dir, 'test');
  return out.sort();
}

function main() {
  const workspace = path.resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Usage: node acceptance.mjs <workspace>');
  const env = { PATH: process.env.PATH ?? '' };
  const failures = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-study-accept-'));
  let hidden = { total: 0, passed: 0 };
  try {
    const script = path.join(tmp, 'hidden-suite.mjs'), resultFile = path.join(tmp, `results-${randomUUID()}.txt`);
    fs.writeFileSync(script, `(${hiddenSuite.toString()})(process.argv[2], process.argv[3], ${CASE_TIMEOUT_MS});\n`);
    spawnSync(process.execPath, [script, workspace, resultFile], { cwd: tmp, env, stdio: 'ignore',
      timeout: HIDDEN_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const lines = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').split('\n') : [];
    const totalLine = lines.find(l => l.startsWith('TOTAL '));
    if (!totalLine) throw new Error('Hidden suite did not start');
    hidden.total = Number(totalLine.slice(6));
    const seen = new Map();
    for (const l of lines) {
      const m = /^(PASS|FAIL) (.+)$/.exec(l);
      if (m && !seen.has(m[2])) seen.set(m[2], m[1] === 'PASS');
    }
    hidden.passed = [...seen.values()].filter(Boolean).length;
    for (const [name, ok] of seen) if (!ok) failures.push(`hidden:${name}`);
    if (seen.size < hidden.total) failures.push(...Array.from({ length: hidden.total - seen.size }, (_, i) => `hidden:not-run-${i + 1}`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const tests = listTests(workspace);
  for (const required of REQUIRED_TEST_FILES) if (!tests.includes(required)) failures.push(`missing:${required}`);
  if (!tests.length) failures.push('agent-tests:none');
  else {
    const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: workspace, env, stdio: 'ignore',
      timeout: AGENT_TESTS_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (run.status !== 0) failures.push('agent-tests:failing');
  }

  console.log(JSON.stringify({ workload: 'large-coupled-invoicing', hiddenCases: hidden.total, hiddenPassed: hidden.passed, agentTestFiles: tests.length, failures }));
  console.log(JSON.stringify({ passed: failures.length === 0, defects: failures.length }));
}

main();
