/**
 * Check each image's git against the CI runner's (#274): a test the builder
 * runs in its session must give the result CI gives.
 *
 * Usage: node scripts/check-git-version.ts <ci-output> <name>=<image-output>...
 *
 * Each file is the output of scripts/git-fixture.sh: `git version X.Y.Z`,
 * then one line per fixture. An image fails when its fixture lines differ
 * from CI's, or when its git is more than MAX_MINOR_GAP minor versions
 * behind CI's. Debian's git stays at one version for a release while the
 * runner's keeps moving, so the gap is loose: it fails about a year after a
 * base image's git is current, which is the prompt to move the base. An image
 * newer than CI passes. The ci.yml job "Image toolchains" runs it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Minor versions an image's git may be behind CI's (agreed on #274). */
export const MAX_MINOR_GAP = 12;

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

export interface FixtureOutput {
  version: GitVersion;
  lines: string[];
}

export function parseGitVersion(line: string): GitVersion {
  const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(line.trim());
  if (!match) throw new Error(`Not a git version line: ${JSON.stringify(line)}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: line.trim() };
}

export function parseFixtureOutput(text: string): FixtureOutput {
  const [first = '', ...rest] = text.trimEnd().split('\n');
  return { version: parseGitVersion(first), lines: rest };
}

/** Minor versions `image` is behind `reference`; negative when it is ahead. */
export function minorGap(reference: GitVersion, image: GitVersion): number {
  if (reference.major !== image.major) return reference.major > image.major ? Infinity : -Infinity;
  return reference.minor - image.minor;
}

/** What is wrong with one image's output against CI's, if anything. */
export function violations(name: string, reference: FixtureOutput, image: FixtureOutput): string[] {
  const found: string[] = [];
  const gap = minorGap(reference.version, image.version);
  if (gap > MAX_MINOR_GAP) {
    found.push(
      `${name}: ${image.version.text} is ${gap === Infinity ? 'a major version' : `${gap} minor versions`} behind CI's ${reference.version.text} (at most ${MAX_MINOR_GAP} allowed).`,
    );
  }
  const length = Math.max(reference.lines.length, image.lines.length);
  for (let i = 0; i < length; i++) {
    const expected = reference.lines[i];
    const actual = image.lines[i];
    if (expected !== actual) {
      found.push(`${name}: fixture line ${i + 1} differs from CI's: CI ${JSON.stringify(expected)}, image ${JSON.stringify(actual)}.`);
    }
  }
  return found;
}

function main(args: string[]): number {
  const [referencePath, ...imageArgs] = args;
  if (!referencePath || imageArgs.length === 0) {
    console.error('Usage: node scripts/check-git-version.ts <ci-output> <name>=<image-output>...');
    return 2;
  }
  const reference = parseFixtureOutput(readFileSync(referencePath, 'utf8'));
  const rows = [`| CI runner | ${reference.version.text} | |`];
  const found: string[] = [];
  for (const arg of imageArgs) {
    const at = arg.indexOf('=');
    if (at < 1) throw new Error(`Expected <name>=<file>, got ${JSON.stringify(arg)}`);
    const name = arg.slice(0, at);
    const image = parseFixtureOutput(readFileSync(arg.slice(at + 1), 'utf8'));
    const problems = violations(name, reference, image);
    rows.push(`| ${name} | ${image.version.text} | ${minorGap(reference.version, image.version)} |`);
    found.push(...problems);
  }
  const table = ['| Where | git | Minor versions behind CI |', '| --- | --- | --- |', ...rows].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## git versions\n\n${table}\n`);
  for (const problem of found) console.error(problem);
  return found.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
