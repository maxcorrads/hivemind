export function checkDelimiter(delimiter) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || ['"', '\r', '\n'].includes(delimiter)) throw new RangeError('Invalid delimiter');
  return delimiter;
}

export function parseCsv(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('parseCsv expects a string');
  const delimiter = checkDelimiter(options.delimiter ?? ',');
  const records = [], n = text.length;
  if (n === 0) return records;
  const separatorAt = at => text[at] === '\n' ? 1 : text[at] === '\r' && text[at + 1] === '\n' ? 2 : 0;
  let i = 0;
  for (;;) {
    const record = [];
    for (;;) {
      let field = '';
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= n) throw new SyntaxError('Unterminated quoted field');
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
            i++;
            break;
          }
          field += text[i++];
        }
        if (i < n && text[i] !== delimiter && !separatorAt(i)) throw new SyntaxError('Unexpected character after a closing quote');
      } else {
        while (i < n && text[i] !== delimiter && !separatorAt(i)) {
          if (text[i] === '"') throw new SyntaxError('Quote inside an unquoted field');
          field += text[i++];
        }
      }
      record.push(field);
      if (i < n && text[i] === delimiter) { i++; continue; }
      break;
    }
    records.push(record);
    if (i >= n) break;
    i += separatorAt(i);
    if (i >= n) break;
  }
  return records;
}
