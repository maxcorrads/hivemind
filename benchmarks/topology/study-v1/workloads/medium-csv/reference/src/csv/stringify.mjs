import { checkDelimiter } from './parse.mjs';

function cell(value, delimiter) {
  let text;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (['number', 'boolean', 'bigint'].includes(typeof value)) text = String(value);
  else throw new TypeError(`Unsupported CSV value type: ${typeof value}`);
  const quote = text.includes(delimiter) || /["\r\n]/.test(text) || text.startsWith(' ') || text.endsWith(' ');
  return quote ? `"${text.replaceAll('"', '""')}"` : text;
}

export function stringifyCsv(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) throw new TypeError('stringifyCsv expects an array of arrays');
  const delimiter = checkDelimiter(options.delimiter ?? ',');
  const newline = options.newline ?? '\n';
  if (newline !== '\n' && newline !== '\r\n') throw new RangeError('newline must be \\n or \\r\\n');
  return rows.map(row => row.map(value => cell(value, delimiter)).join(delimiter) + newline).join('');
}
