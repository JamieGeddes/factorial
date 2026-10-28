import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROLE_NAMES } from './index.ts';

const packages = fileURLToPath(new URL('../../', import.meta.url));

/** Every TypeScript source file under a package's src/, tests aside. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

const names = ROLE_NAMES.join('|');
/** A comparison with a role's name, or a branch on a value called role. */
const CONDITIONALS = [
  new RegExp(String.raw`[!=]==?\s*['"\`](?:${names})['"\`]`),
  new RegExp(String.raw`['"\`](?:${names})['"\`]\s*[!=]==?`),
  new RegExp(String.raw`case\s+['"\`](?:${names})['"\`]`),
  /switch\s*\(\s*[\w.]*\brole\s*\)/i,
];

describe('role conditionals', () => {
  it('appear nowhere outside @factorial/roles: a role is its manifest', () => {
    const found: string[] = [];
    for (const name of readdirSync(packages)) {
      if (name === 'roles') continue;
      const src = path.join(packages, name, 'src');
      let files: string[];
      try {
        files = sources(src);
      } catch {
        continue;
      }
      for (const file of files) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (CONDITIONALS.some((pattern) => pattern.test(line))) found.push(`${path.relative(packages, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    assert.deepEqual(found, []);
  });
});
