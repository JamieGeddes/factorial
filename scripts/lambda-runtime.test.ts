import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const LAMBDA_BUILDS = ['packages/orchestration/build.ts', 'packages/triggers-github-issues/build.ts'];

function templateRuntimes(): string[] {
  const dir = path.join(root, 'templates');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => [...readFileSync(path.join(dir, name), 'utf8').matchAll(/^\s*Runtime:\s*nodejs(\d+)\.x\s*$/gm)].map((m) => m[1] as string));
}

describe('Lambda runtime', () => {
  it('is one Node version across the templates, and every Lambda bundle targets it', () => {
    const runtimes = templateRuntimes();
    assert.ok(runtimes.length > 0, 'no nodejsNN.x runtime found in templates/');
    const major = runtimes[0];
    assert.deepEqual([...new Set(runtimes)], [major], 'templates declare different Lambda runtimes');
    for (const build of LAMBDA_BUILDS) {
      const targets = [...readFileSync(path.join(root, build), 'utf8').matchAll(/target:\s*'(node\d+)'/g)].map((m) => m[1]);
      assert.ok(targets.length > 0, `${build} has no esbuild target`);
      assert.deepEqual([...new Set(targets)], [`node${major}`], `${build} does not target the runtime nodejs${major}.x`);
    }
  });
});
