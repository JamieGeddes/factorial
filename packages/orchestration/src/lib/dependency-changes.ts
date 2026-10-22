/**
 * Dependency changes between the base commit and the agent's head, computed
 * inside the builder's session by a script and parsed out of its output. The
 * session is hostile once the agent has run, so the parse never trusts its
 * shape: anything unexpected yields an empty result, never a throw.
 */

/** The section marker appended to Collect's inspection output. */
export const DEPENDENCY_SECTION = '===FACTORIAL-DEPS===';

/** At most this many added or removed packages travel in the state. */
export const MAX_DEPENDENCY_CHANGES = 20;

export interface DependencyChange {
  name: string;
  /** The lockfile's `license` field for the package, when it records one. */
  licence?: string | undefined;
}

export interface DependencyChanges {
  added: DependencyChange[];
  removed: string[];
}

export const NO_DEPENDENCY_CHANGES: DependencyChanges = { added: [], removed: [] };

interface RawSection {
  old?: unknown;
  new?: unknown;
  licences?: unknown;
}

/** The dependency names from a merged map or a whole package.json: the union of its dependencies and devDependencies. */
function nameMap(value: unknown): Map<string, true> {
  const names = new Map<string, true>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return names;
  const record = value as Record<string, unknown>;
  const blocks = [value, record.dependencies, record.devDependencies];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof name === 'string' && name.length > 0 && typeof spec === 'string') names.set(name, true);
    }
  }
  return names;
}

function licenceMap(value: unknown): Map<string, string> {
  const licences = new Map<string, string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return licences;
  for (const [name, licence] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === 'string' && name.length > 0 && typeof licence === 'string' && licence.length > 0) licences.set(name, licence);
  }
  return licences;
}

/**
 * Compute the added and removed packages from the two dependency maps, with
 * each added package's licence from the lockfile. Both lists are capped.
 */
export function dependencyChanges(section: unknown): DependencyChanges {
  if (typeof section !== 'object' || section === null) return NO_DEPENDENCY_CHANGES;
  const raw = section as RawSection;
  const oldDeps = nameMap(raw.old);
  const newDeps = nameMap(raw.new);
  const licences = licenceMap(raw.licences);
  const added: DependencyChange[] = [];
  for (const name of newDeps.keys()) {
    if (oldDeps.has(name)) continue;
    added.push({ name, ...(licences.has(name) ? { licence: licences.get(name) } : {}) });
  }
  const removed: string[] = [];
  for (const name of oldDeps.keys()) {
    if (!newDeps.has(name)) removed.push(name);
  }
  return { added: added.slice(0, MAX_DEPENDENCY_CHANGES), removed: removed.slice(0, MAX_DEPENDENCY_CHANGES) };
}

const MAX_SECTION_CHARS = 1_000_000;

/**
 * Decode and parse the section's base64 JSON, then diff it. Any malformed
 * section (bad base64, bad JSON, wrong shape, absurdly large) yields an
 * empty result: the Dependencies bullet says so by being absent, and a raw
 * diff is in the artefacts.
 */
export function parseDependencyChanges(section: string | undefined): DependencyChanges {
  if (!section) return NO_DEPENDENCY_CHANGES;
  if (section.length > MAX_SECTION_CHARS) return NO_DEPENDENCY_CHANGES;
  if (!/^[A-Za-z0-9+/=]*$/.test(section)) return NO_DEPENDENCY_CHANGES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(section, 'base64').toString('utf8'));
  } catch {
    return NO_DEPENDENCY_CHANGES;
  }
  return dependencyChanges(parsed);
}
