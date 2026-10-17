/**
 * Classify the changes between two commits as functional or non-functional.
 *
 * This file is the single place that defines which paths cannot affect what
 * Factorial deploys. The CI workflow runs a fast path for changes that touch
 * only these paths, and the deploy workflow skips the deploy entirely when
 * nothing functional has changed since the last successful deploy (the
 * `FactorialVersion` parameter on the `factorial-orchestration` stack). Both
 * go through `.github/actions/classify-changes`, which runs this script; add
 * a path here once and both workflows pick it up. Update the convention in
 * `CLAUDE.md` in the same change.
 *
 * Usage: node scripts/classify-changes.ts <base-commit> <head-commit>
 *
 * Prints the classification with the reason and, when running in GitHub
 * Actions, writes `functional=true|false` to $GITHUB_OUTPUT. Everything not
 * in the non-functional list is functional, so an unrecognised path always
 * counts as functional: the safe default is to build and deploy.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Paths whose change cannot affect what is built, tested or deployed. */
const NON_FUNCTIONAL_PATHS = [
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'README.md',
  '.editorconfig',
  '.github/CODEOWNERS',
  // Everything under docs/ is background material, not code or configuration.
  'docs/',
] as const;

export function isNonFunctionalPath(path: string): boolean {
  return NON_FUNCTIONAL_PATHS.some(
    (nonFunctional) =>
      path === nonFunctional ||
      (nonFunctional.endsWith('/') && path.startsWith(nonFunctional)),
  );
}

export interface Classification {
  functional: boolean;
  /** The paths that made the change functional, if any. */
  functionalPaths: string[];
}

export function classifyChanges(changedPaths: string[]): Classification {
  const functionalPaths = changedPaths.filter((path) => !isNonFunctionalPath(path));
  return { functional: functionalPaths.length > 0, functionalPaths };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main(): void {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('usage: node scripts/classify-changes.ts <base-commit> <head-commit>');
    process.exitCode = 2;
    return;
  }

  // Diffing against the merge base reports what head introduces even when the
  // base has moved on, and it is what the deploy workflow wants when comparing
  // a push against the last deployed commit (an ancestor of head).
  const mergeBase = git('merge-base', base, head);
  const changedPaths = git('diff', '--name-only', mergeBase, head)
    .split('\n')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  const { functional: hasFunctionalPaths, functionalPaths } = classifyChanges(changedPaths);

  let functional = hasFunctionalPaths;
  if (changedPaths.length === 0) {
    // No paths at all between the two commits is an unknown state, not a
    // non-functional change: an absent or unreadable comparison must never
    // skip a deploy.
    functional = true;
    console.log(`No changed paths between ${mergeBase} and ${head}; treating the change as functional.`);
  }

  console.log(`Comparing ${head} against ${mergeBase} (base ${base}).`);
  for (const path of changedPaths) {
    console.log(`  ${isNonFunctionalPath(path) ? 'non-functional' : 'functional'}: ${path}`);
  }
  if (functional) {
    console.log(
      `Functional change: ${functionalPaths.length} of ${changedPaths.length} changed path(s) ` +
        'can affect what is deployed; build and deploy.',
    );
  } else {
    console.log(
      `Non-functional change: none of the ${changedPaths.length} changed path(s) can affect ` +
        'what is deployed; skip the build and deploy.',
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `functional=${functional}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
