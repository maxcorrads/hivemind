export function wrapText(text, width) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isInteger(width) || width < 1) throw new RangeError('width must be an integer >= 1');
  const paragraphs = [];
  let current = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.trim() === '') { if (current.length) paragraphs.push(current); current = []; }
    else current.push(...line.split(/\s+/).filter(Boolean));
  }
  if (current.length) paragraphs.push(current);
  return paragraphs.map(words => fill(words, width).join('\n')).join('\n\n');
}

function fill(words, width) {
  const lines = [];
  let line = '';
  for (const word of words) {
    if (word.length > width) {
      if (line) lines.push(line);
      let rest = word;
      while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width); }
      line = rest;
    } else if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}
