import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { bundlesIn, unloadable } from './check-bundles.ts';

const BANNER = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

describe('check-bundles', () => {
  it('finds every .mjs under the roots, nested ones included', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bundles-'));
    mkdirSync(path.join(root, 'prepare'));
    writeFileSync(path.join(root, 'host.mjs'), '');
    writeFileSync(path.join(root, 'host.mjs.map'), '');
    writeFileSync(path.join(root, 'prepare', 'index.mjs'), '');
    assert.deepEqual(bundlesIn([root]).map((file) => path.relative(root, file)).sort(), ['host.mjs', path.join('prepare', 'index.mjs')]);
  });

  it('passes a bundle that loads and reports one that declares createRequire twice', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bundles-'));
    const good = path.join(root, 'good.mjs');
    const bad = path.join(root, 'bad.mjs');
    writeFileSync(good, `${BANNER}\nexport const ok = require('node:path').sep;\n`);
    writeFileSync(bad, `${BANNER}\nimport { createRequire } from 'node:module';\nexport const r = createRequire;\n`);
    const failures = unloadable([good, bad]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.file, bad);
    assert.match(failures[0]?.error ?? '', /SyntaxError: Identifier 'createRequire' has already been declared/);
  });
});
