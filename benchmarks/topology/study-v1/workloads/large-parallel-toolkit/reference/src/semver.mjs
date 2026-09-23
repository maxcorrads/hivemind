const NUM = '(0|[1-9]\\d*)';
const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function parse(version) {
  const m = typeof version === 'string' ? VERSION.exec(version) : null;
  if (!m) throw new TypeError(`Invalid version: ${String(version)}`);
  const prerelease = m[4] === undefined ? [] : m[4].split('.').map(id => /^\d+$/.test(id) ? Number(id) : id);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

const sign = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

function compareParsed(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return sign(a[k] - b[k]);
  const pa = a.prerelease, pb = b.prerelease;
  if (!pa.length && !pb.length) return 0;
  if (!pa.length) return 1;
  if (!pb.length) return -1;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) return sign(x - y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return sign(pa.length - pb.length);
}

export function compare(a, b) { return compareParsed(parse(a), parse(b)); }

function comparator(token) {
  if (token === '*') return { test: () => true, named: null };
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  const op = m[1] ?? '=';
  const low = parse(m[2]);
  const bound = (lo, hi) => ({ test: v => compareParsed(v, lo) >= 0 && compareParsed(v, hi) < 0, named: low });
  const at = (major, minor, patch) => ({ major, minor, patch, prerelease: [] });
  if (op === '^') {
    if (low.major > 0) return bound(low, at(low.major + 1, 0, 0));
    if (low.minor > 0) return bound(low, at(0, low.minor + 1, 0));
    return bound(low, at(0, 0, low.patch + 1));
  }
  if (op === '~') return bound(low, at(low.major, low.minor + 1, 0));
  const tests = { '=': c => c === 0, '>': c => c > 0, '>=': c => c >= 0, '<': c => c < 0, '<=': c => c <= 0 };
  return { test: v => tests[op](compareParsed(v, low)), named: low };
}

export function satisfies(version, range) {
  const v = parse(version);
  if (typeof range !== 'string') throw new TypeError('Range must be a string');
  const sets = range.split('||').map(set => set.trim());
  if (sets.some(set => set === '')) throw new TypeError(`Invalid range: ${range}`);
  const parsed = sets.map(set => set.split(/\s+/).map(comparator));
  return parsed.some(set => set.every(c => c.test(v)) && (v.prerelease.length === 0 || set.some(c => c.named && c.named.prerelease.length > 0 &&
    c.named.major === v.major && c.named.minor === v.minor && c.named.patch === v.patch)));
}
