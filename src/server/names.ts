const BRAINS = [
  "Atlas",
  "Minerva",
  "Helix",
  "Prism",
  "Meridian",
  "Axiom",
  "Keystone",
  "Quorum",
  "Harbor",
  "Vertex",
  "Palladium",
  "Cipher",
  "Solace",
  "Nexus",
  "Lumen",
  "Cord",
  "Truss",
  "Datum",
];

const WORKERS = [
  "Anvil",
  "Forge",
  "Chisel",
  "Lathe",
  "Rivet",
  "Adze",
  "Maul",
  "Wedge",
  "Plumb",
  "Vice",
  "Swage",
  "Drift",
  "Broach",
  "Reamer",
  "Arbor",
  "Collet",
  "Gauge",
  "Spindle",
  "Quill",
  "Loom",
  "Tread",
  "Kerf",
  "Rabbet",
  "Dowel",
  "Ferro",
  "Tempera",
  "Flux",
  "Crucible",
  "Tuyere",
  "Mandrel",
  "Scribe",
  "Burin",
  "Fret",
  "Jig",
  "Cam",
  "Pawl",
  "Ratchet",
  "Capstan",
  "Windlass",
  "Spar",
];

const PREFIXES = [
  "Amber",
  "Ash",
  "Azure",
  "Birch",
  "Cedar",
  "Cobalt",
  "Copper",
  "Coral",
  "Crimson",
  "Ember",
  "Frost",
  "Golden",
  "Indigo",
  "Iron",
  "Jade",
  "Juniper",
  "Onyx",
  "Pearl",
  "Silver",
  "Willow",
];

const SUFFIXES = [
  "Anchor",
  "Beacon",
  "Blade",
  "Bloom",
  "Brook",
  "Cairn",
  "Cinder",
  "Cliff",
  "Cove",
  "Crown",
  "Dawn",
  "Delta",
  "Echo",
  "Field",
  "Flint",
  "Grove",
  "Haven",
  "Key",
  "Lake",
  "March",
  "Peak",
  "Reef",
  "Ridge",
  "Stone",
  "Vale",
];

const GENERATED = PREFIXES.flatMap((prefix) => SUFFIXES.map((suffix) => `${prefix}${suffix}`));

/**
 * Shared pool across brain/worker roles. The original role-specific names are kept as
 * the first-choice pool, then both roles draw from the same remaining names so a hive
 * can assign 500 globally unique human-readable identities regardless of role mix.
 */
const AGENT_NAMES = [...new Set([...BRAINS, ...WORKERS, ...GENERATED])].slice(0, 500);

export function pickName(role: "brain" | "worker", taken: Set<string>): string {
  const preferred = role === "brain" ? BRAINS : WORKERS;
  const availablePreferred = preferred.filter((name) => !taken.has(name.toLowerCase()));
  if (availablePreferred.length > 0) {
    return availablePreferred[cryptoRandom(availablePreferred.length)]!;
  }

  const available = AGENT_NAMES.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[cryptoRandom(available.length)]!;
  }

  const base = role === "brain" ? "Brain" : "Worker";
  let n = 1;
  while (taken.has(`${base}${n}`.toLowerCase())) n += 1;
  return `${base}${n}`;
}

function cryptoRandom(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}
