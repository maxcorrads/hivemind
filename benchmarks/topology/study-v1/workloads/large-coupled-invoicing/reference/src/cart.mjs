import { add, money, multiply } from './money.mjs';

export function createCart(catalog) {
  const quantities = new Map();
  const cart = {
    add(sku, quantity = 1) {
      if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('quantity must be a positive integer');
      catalog.get(sku); // throws RangeError for an unknown sku
      quantities.set(sku, (quantities.get(sku) ?? 0) + quantity);
      return cart;
    },
    setQuantity(sku, quantity) {
      if (!quantities.has(sku)) throw new RangeError(`${sku} is not in the cart`);
      if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError('quantity must be a non-negative integer');
      if (quantity === 0) quantities.delete(sku); else quantities.set(sku, quantity);
      return cart;
    },
    remove(sku) { return quantities.delete(sku); },
    lines() {
      return [...quantities].map(([sku, quantity]) => {
        const product = catalog.get(sku);
        return { sku, name: product.name, quantity, unitPrice: product.price, taxCategory: product.taxCategory,
          subtotal: multiply(product.price, quantity) };
      });
    },
    subtotal() { return cart.lines().reduce((sum, line) => add(sum, line.subtotal), money(0, catalog.currency)); },
  };
  return cart;
}
