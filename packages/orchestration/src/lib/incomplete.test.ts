/**
 * The invoker and the orchestrator each define INCOMPLETE_EXIT_CODE; if they
 * drift, every builder that stops at its limit is treated as failed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { INCOMPLETE_EXIT_CODE } from './incomplete.js';

test('INCOMPLETE_EXIT_CODE matches the invoker', () => {
  const role = readFileSync(new URL('../../../invoker/src/role.ts', import.meta.url), 'utf8');
  const match = /export const INCOMPLETE_EXIT_CODE = (\d+);/.exec(role);
  assert.ok(match, 'INCOMPLETE_EXIT_CODE not found in invoker role.ts');
  assert.equal(Number(match[1]), INCOMPLETE_EXIT_CODE);
});
