/**
 * Facts about a change that the orchestrator works out for the pull request
 * itself, never from agent text: contract changes, dependency changes with
 * their licences, and the deploy impact the target repository's own settings
 * imply. They are computed in the reviewer's fresh session, which is seeded
 * after the push and before any agent runs there, from the base branch and
 * the pushed head. Nothing here assumes a layout: which paths mean a deploy,
 * and which of those need a human, come from the target's
 * .factorial/pr-body.json on the base branch, read like sensitive-paths.json.
 */
import { HARDENED_GIT_ENV, assertGitBranch, shellQuote } from './shell.ts';
import type { SensitiveChange } from './review-files.ts';

export const PR_BODY_SETTINGS_FILE = '.factorial/pr-body.json';
export const MAX_SETTINGS_BYTES = 64 * 1024;
/** Each file read for the dependency diff is cut to this many bytes. */
const MAX_DEP_FILE_BYTES = 256 * 1024;
/** The lockfile is read this large at most; a larger one gives no licences. */
const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES = 30;
const MAX_DEPENDENCY_CHANGES = 20;
const MAX_CONTRACTS = 20;
const MAX_RULES = 20;
const DIGEST_CHARS = 6000;
const LINE_SEP = '\n';

export const NO_LICENCE = 'licence not stated in the lockfile';

export interface DependencyChange {
  name: string;
  change: 'added' | 'removed';
  /** The version range in package.json. */
  version: string;
  dev: boolean;
  /** The package.json it appears in. */
  file: string;
  /** For an added package, from the lockfile at the pushed head. */
  licence?: string;
}

export interface DeployRule {
  prefix: string;
  note: string;
}

export interface DeploySettings {
  paths: DeployRule[];
  humanSteps: DeployRule[];
}

export interface DeployImpact {
  /** Whether the target has a settings file at all. */
  configured: boolean;
  /** What changes, one line per rule that matched. */
  notes: string[];
  /** The human steps implied, one line per rule that matched. */
  humanSteps: string[];
}

export interface PrFacts {
  sensitive: SensitiveChange[];
  contracts: string[];
  dependencies: DependencyChange[];
  deploy: DeployImpact;
  /** Set when the digest had to drop entries to fit the state. */
  truncated?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRules(value: unknown, where: string, problems: string[]): DeployRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array`);
    return [];
  }
  const rules: DeployRule[] = [];
  for (const [i, item] of value.slice(0, MAX_RULES).entries()) {
    if (isObject(item) && typeof item.prefix === 'string' && item.prefix.length > 0 && item.prefix.length <= 200 && typeof item.note === 'string' && item.note.length > 0 && item.note.length <= 200) {
      rules.push({ prefix: item.prefix, note: item.note });
    } else {
      problems.push(`${where}[${i}] needs a "prefix" and a "note", each 1 to 200 characters`);
    }
  }
  return rules;
}

/** The target's settings, or why they were not used. Invalid files are ignored, never thrown on. */
export function parseDeploySettings(text: string | undefined): { settings?: DeploySettings; problems: string[] } {
  if (text === undefined) return { problems: [] };
  if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) return { problems: [`${PR_BODY_SETTINGS_FILE} is over the ${MAX_SETTINGS_BYTES}-byte limit`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problems: [`${PR_BODY_SETTINGS_FILE} is not valid JSON`] };
  }
  if (!isObject(json) || json.schemaVersion !== 1) return { problems: [`${PR_BODY_SETTINGS_FILE} must be an object with "schemaVersion": 1`] };
  const problems: string[] = [];
  const deploy = json.deploy;
  if (deploy !== undefined && !isObject(deploy)) return { problems: [`${PR_BODY_SETTINGS_FILE} "deploy" must be an object`] };
  const settings = {
    paths: parseRules(deploy?.paths, 'deploy.paths', problems),
    humanSteps: parseRules(deploy?.humanSteps, 'deploy.humanSteps', problems),
  };
  return { settings, problems: problems.map((p) => `${PR_BODY_SETTINGS_FILE} ${p}`) };
}

function matching(rules: readonly DeployRule[], changedPaths: readonly string[]): string[] {
  const lines: string[] = [];
  for (const rule of rules) {
    const hits = changedPaths.filter((p) => p.startsWith(rule.prefix));
    if (hits.length === 0) continue;
    const shown = hits.slice(0, 3).map((p) => `\`${p}\``).join(', ');
    lines.push(`${rule.note}: ${shown}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}`);
  }
  return lines;
}

export function deployImpact(settings: DeploySettings | undefined, changedPaths: readonly string[]): DeployImpact {
  if (!settings) return { configured: false, notes: [], humanSteps: [] };
  return { configured: true, notes: matching(settings.paths, changedPaths), humanSteps: matching(settings.humanSteps, changedPaths) };
}

/** Changed paths under contracts/. */
export const contractChanges = (changedPaths: readonly string[]): string[] =>
  changedPaths.filter((p) => p.startsWith('contracts/')).slice(0, MAX_CONTRACTS);

function declared(text: string | undefined): Map<string, { version: string; dev: boolean }> {
  const result = new Map<string, { version: string; dev: boolean }>();
  if (text === undefined) return result;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return result;
  }
  if (!isObject(json)) return result;
  for (const [field, dev] of [['dependencies', false], ['devDependencies', true]] as const) {
    const block = json[field];
    if (!isObject(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      if (typeof version === 'string' && !result.has(name)) result.set(name, { version, dev });
    }
  }
  return result;
}

/** The licence the lockfile records for a package, at its top-level install. */
function lockfileLicences(lockText: string | undefined): (name: string) => string | undefined {
  let packages: Record<string, unknown> = {};
  try {
    const json: unknown = lockText === undefined ? undefined : JSON.parse(lockText);
    if (isObject(json) && isObject(json.packages)) packages = json.packages;
  } catch {
    // no licences
  }
  return (name) => {
    const entry = packages[`node_modules/${name}`];
    const licence = isObject(entry) ? entry.license : undefined;
    return typeof licence === 'string' && licence.length > 0 && licence.length <= 100 ? licence : undefined;
  };
}

export interface PackageFileVersions {
  path: string;
  /** Absent when the file is new. */
  base?: string | undefined;
  /** Absent when the file was deleted. */
  head?: string | undefined;
}

/** Packages added to or removed from `dependencies` and `devDependencies` of any package.json, with each added package's licence. Never throws. */
export function dependencyChanges(files: readonly PackageFileVersions[], lockText: string | undefined): DependencyChange[] {
  const licence = lockfileLicences(lockText);
  const changes: DependencyChange[] = [];
  for (const file of files) {
    const before = declared(file.base);
    const after = declared(file.head);
    for (const [name, now] of after) {
      if (!before.has(name)) changes.push({ name, change: 'added', version: now.version, dev: now.dev, file: file.path, licence: licence(name) ?? NO_LICENCE });
    }
    for (const [name, was] of before) {
      if (!after.has(name)) changes.push({ name, change: 'removed', version: was.version, dev: was.dev, file: file.path });
    }
  }
  return changes.slice(0, MAX_DEPENDENCY_CHANGES);
}

/**
 * Print, for each package.json the branch changed, its copy on the base
 * branch and at HEAD, then the root package-lock.json at HEAD. One line per
 * file: `F <base64 path> <base64 base or -> <base64 head or ->`, then
 * `L <base64 lockfile or ->`. Everything is base64 so no content can break
 * the format.
 */
export function depsScript(params: { baseBranch: string }): string {
  const base = `origin/${assertGitBranch(params.baseBranch, 'base branch')}`;
  const range = shellQuote(`${base}...HEAD`);
  const b64 = (cmd: string, limit = MAX_DEP_FILE_BYTES): string => `${cmd} | head -c ${limit} | base64 -w0`;
  return [
    // No -e: head closing a pipe early makes git show fail, which is not an error here.
    'set -uo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    'count=0',
    `git diff -z --name-only --no-renames --no-ext-diff ${range} -- 'package.json' '*/package.json' | while IFS= read -r -d '' f; do`,
    `  count=$((count + 1)); [ "$count" -le ${MAX_PACKAGE_FILES} ] || break`,
    `  printf 'F %s ' "$(printf '%s' "$f" | base64 -w0)"`,
    `  if git cat-file -e ${shellQuote(`${base}:`)}"$f" 2>/dev/null; then ${b64(`git show ${shellQuote(`${base}:`)}"$f"`)}; else printf -- '-'; fi`,
    `  printf ' '`,
    `  if git cat-file -e "HEAD:$f" 2>/dev/null; then ${b64('git show "HEAD:$f"')}; else printf -- '-'; fi`,
    `  printf '\\n'`,
    'done',
    `if git cat-file -e HEAD:package-lock.json 2>/dev/null; then printf 'L '; ${b64('git show HEAD:package-lock.json', MAX_LOCKFILE_BYTES)}; printf '\\n'; else printf 'L -\\n'; fi`,
  ].join(LINE_SEP);
}

const decode = (field: string | undefined): string | undefined => {
  if (field === undefined || field === '-') return undefined;
  if (!/^[A-Za-z0-9+/=]*$/.test(field)) throw new Error('dependency listing did not produce base64 output');
  return Buffer.from(field, 'base64').toString('utf8');
};

/** Read depsScript's output. Throws on a malformed listing; the caller treats that as "not determined". */
export function parseDeps(stdout: string): { files: PackageFileVersions[]; lockText: string | undefined } {
  const files: PackageFileVersions[] = [];
  let lockText: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(' ');
    if (parts[0] === 'F' && parts.length === 4) {
      files.push({ path: decode(parts[1])!, base: decode(parts[2]), head: decode(parts[3]) });
    } else if (parts[0] === 'L' && parts.length === 2) {
      lockText = decode(parts[1]);
    } else {
      throw new Error('dependency listing was not in the expected form');
    }
  }
  return { files, lockText };
}

/** The facts as the state machine carries them to the pull request: entries dropped, last first, until the JSON fits. */
export function prFactsDigest(facts: PrFacts): PrFacts {
  const out: PrFacts = { ...facts, sensitive: [...facts.sensitive], contracts: [...facts.contracts], dependencies: [...facts.dependencies] };
  const size = (): number => JSON.stringify(out).length;
  let cut = false;
  while (size() > DIGEST_CHARS) {
    const list = [out.dependencies, out.contracts, out.sensitive].find((l) => l.length > 0);
    if (!list) {
      out.deploy = { ...out.deploy, notes: out.deploy.notes.slice(0, 3), humanSteps: out.deploy.humanSteps.slice(0, 3) };
      cut = true;
      break;
    }
    list.pop();
    cut = true;
  }
  return cut ? { ...out, truncated: true } : out;
}
