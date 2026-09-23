const CATEGORIES = ['standard', 'reduced', 'exempt'];

function validProduct(p) {
  return p && typeof p === 'object' && typeof p.sku === 'string' && p.sku !== '' && typeof p.name === 'string' && p.name !== '' &&
    p.price && Number.isSafeInteger(p.price.amount) && p.price.amount >= 0 && typeof p.price.currency === 'string' &&
    /^[A-Z]{3}$/.test(p.price.currency) && CATEGORIES.includes(p.taxCategory);
}

export function createCatalog(products) {
  if (!Array.isArray(products) || products.length === 0 || !products.every(validProduct)) throw new TypeError('Invalid product list');
  const currency = products[0].price.currency;
  const bySku = new Map();
  for (const p of products) {
    if (bySku.has(p.sku)) throw new Error(`Duplicate sku ${p.sku}`);
    if (p.price.currency !== currency) throw new TypeError('All products must share one currency');
    bySku.set(p.sku, Object.freeze({ sku: p.sku, name: p.name, price: Object.freeze({ amount: p.price.amount, currency }), taxCategory: p.taxCategory }));
  }
  return Object.freeze({
    currency,
    get(sku) {
      if (!bySku.has(sku)) throw new RangeError(`Unknown sku ${sku}`);
      return bySku.get(sku);
    },
    has(sku) { return bySku.has(sku); },
  });
}
