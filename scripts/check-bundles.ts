/**
 * Check that every bundle the build wrote loads as an ES module. Each build
 * adds a banner that imports createRequire; on 2026-10-28 a source file that
 * imported it too made agent-runtime/dist/host.mjs a duplicate declaration,
 * which the unit tests (run on the source) and the build (which only writes
 * the file) both missed, and the Runtimes failed to start at deploy.
 * `node --check` parses each file as a module without running it, so it
 * catches any early error of that kind. Runs as part of `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directories the workspace builds write to. */
export function bundleRoots(repository: string): string[] {
  const packages = path.join(repository, 'packages');
  return [
    path.join(repository, 'agent-runtime', 'dist'),
    path.join(repository, 'invoker', 'dist'),
    ...readdirSync(packages).map((name) => path.join(packages, name, 'dist')),
  ].filter((root) => existsSync(root));
}

export function bundlesIn(roots: string[]): string[] {
  return roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => path.join(root, file)),
  );
}

/** The bundles that do not parse, each with the first line of its error. */
export function unloadable(bundles: string[]): { file: string; error: string }[] {
  const failures: { file: string; error: string }[] = [];
  for (const file of bundles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer }).stderr ?? error);
      failures.push({ file, error: stderr.split('\n').find((line) => /Error/.test(line)) ?? stderr.trim() });
    }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundles = bundlesIn(bundleRoots(repository));
  if (bundles.length === 0) {
    console.error('No bundles found: run the workspace builds first.');
    process.exit(1);
  }
  const failures = unloadable(bundles);
  for (const { file, error } of failures) console.error(`${path.relative(repository, file)}: ${error}`);
  if (failures.length > 0) process.exit(1);
  console.log(`bundle check passed (${bundles.length} bundles).`);
}
