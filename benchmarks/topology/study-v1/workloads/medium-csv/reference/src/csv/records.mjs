const TYPES = ['string', 'number', 'integer', 'boolean'];
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

function convert(raw, type, column) {
  if (type === 'string') return raw;
  const value = raw.trim();
  if (value === '') return null;
  if (type === 'number' && NUMBER.test(value)) return Number(value);
  if (type === 'integer' && INTEGER.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (type === 'boolean' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  throw new TypeError(`Column ${column}: cannot convert ${JSON.stringify(raw)} to ${type}`);
}

export function toRecords(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new RangeError('A header row is required');
  const header = rows[0];
  if (!header.every(name => typeof name === 'string' && name !== '') || new Set(header).size !== header.length) {
    throw new SyntaxError('Header names must be non-empty and unique');
  }
  const types = options.types ?? {};
  for (const [name, type] of Object.entries(types)) {
    if (!header.includes(name)) throw new RangeError(`Unknown column ${name}`);
    if (!TYPES.includes(type)) throw new RangeError(`Unknown type ${type}`);
  }
  return rows.slice(1).map((row, index) => {
    if (row.length !== header.length) throw new RangeError(`row ${index + 2} has ${row.length} fields, expected ${header.length}`);
    const record = {};
    header.forEach((name, column) => { record[name] = convert(row[column], types[name] ?? 'string', name); });
    return record;
  });
}

export function fromRecords(records, columns) {
  const cols = columns ?? (records.length ? Object.keys(records[0]) : []);
  if (!records.length && !cols.length) return [];
  return [[...cols], ...records.map(record => cols.map(name => {
    const value = record[name];
    return value === null || value === undefined ? '' : String(value);
  }))];
}
