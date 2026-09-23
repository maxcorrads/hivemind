const UNITS = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]];
const COMPONENT = /(\d+(?:\.\d+)?)(ms|d|h|m|s)\s*/y;

export function parseDuration(input) {
  if (typeof input !== 'string') throw new TypeError('parseDuration expects a string');
  const text = input.trim();
  if (!text) throw new RangeError('Empty duration');
  let total = 0, lastRank = -1;
  COMPONENT.lastIndex = 0;
  while (COMPONENT.lastIndex < text.length) {
    const start = COMPONENT.lastIndex;
    const match = COMPONENT.exec(text);
    if (!match || match.index !== start) throw new RangeError(`Invalid duration: ${input}`);
    const rank = UNITS.findIndex(([unit]) => unit === match[2]);
    if (rank <= lastRank) throw new RangeError(`Units must be unique and in descending order: ${input}`);
    lastRank = rank;
    total += Number(match[1]) * UNITS[rank][1];
  }
  return Math.round(total);
}
