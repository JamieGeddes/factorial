import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { logExcerpt } from './log-excerpt.ts';

const STAMP = '2026-11-02T10:15:30.1234567Z ';

/** An early node-TAP failure with diagnostics, as GitHub prints it. */
function tapFailure(name: string, extra: string[] = []): string[] {
  return [
    `    not ok 1 - ${name}`,
    '      ---',
    '      duration_ms: 3.2',
    "      failureType: 'testCodeFailure'",
    '      error: |-',
    '        Expected values to be strictly equal:',
    "      code: 'ERR_ASSERTION'",
    "      expected: 'a'",
    "      actual: 'b'",
    '      stack: |-',
    ...Array.from({ length: 10 }, (_, i) => `        at frame${i + 1} (file.ts:${i}:1)`),
    ...extra,
    '      ...',
  ];
}

function passing(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `ok ${i + 1} - passes ${i + 1}`);
}

const stamped = (lines: string[]): string => lines.map((line) => `${STAMP}${line}`).join('\n');

describe('logExcerpt', () => {
  const log = stamped([...passing(5), ...tapFailure('clean-room rejects a path outside the workspace'), ...passing(600), '##[error]Process completed with exit code 1.']);

  it('carries an early TAP failure with its diagnostics, ahead of the tail', () => {
    const out = logExcerpt(log, { maxBytes: 64 * 1024 });
    assert.match(out, /not ok 1 - clean-room rejects a path outside the workspace/);
    assert.match(out, /expected: 'a'/);
    assert.match(out, /actual: 'b'/);
    assert.match(out, /Expected values to be strictly equal/);
    assert.match(out, /at frame1 /);
    assert.match(out, /at frame5 /);
    assert.doesNotMatch(out, /at frame6 /);
    assert.match(out, /--- failure lines before the tail \(1 of 1\) ---/);
    assert.match(out, /--- last 200 lines ---/);
    assert.match(out, /passes 600\n##\[error\]Process completed/);
  });

  it('strips timestamps and leaves out passing tests from before the tail', () => {
    const out = logExcerpt(log, { maxBytes: 64 * 1024 });
    assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T\d{2}:/);
    assert.doesNotMatch(out, /passes 3\n/);
  });

  it('keeps ##[error] lines from before the tail', () => {
    const out = logExcerpt(stamped(['##[error]Something broke', ...passing(300)]), { maxBytes: 64 * 1024 });
    assert.match(out, /--- failure lines before the tail \(1 of 1\) ---\n##\[error\]Something broke/);
  });

  it('does not take a passing test whose name says error as a failure', () => {
    const out = logExcerpt(['    ok 4 - handles error cases', '# Subtest: reports an error', ...passing(300)].join('\n'), { maxBytes: 64 * 1024 });
    assert.doesNotMatch(out, /failure lines/);
    assert.doesNotMatch(out, /handles error cases/);
  });

  it('cuts one failure at the per-failure cap', () => {
    const diff = Array.from({ length: 500 }, (_, i) => `        diff line ${i}`);
    const out = logExcerpt([...tapFailure('big diff').slice(0, 7), '      expected: |-', ...diff, "      actual: 'b'", '      ...', ...passing(300)].join('\n'), { maxBytes: 64 * 1024 });
    assert.match(out, /not ok 1 - big diff/);
    assert.match(out, /diff line 0\n/);
    assert.doesNotMatch(out, /diff line 100\n/);
    assert.match(out, /… \(cut\)/);
    assert.match(out, /--- last 200 lines ---/);
  });

  it('stays within the budget with many failures, keeps the tail and says how many it dropped', () => {
    const failures = Array.from({ length: 30 }, (_, i) => tapFailure(`case ${i}`)).flat();
    const maxBytes = 8 * 1024;
    const out = logExcerpt([...failures, ...passing(300)].join('\n'), { maxBytes });
    assert.ok(Buffer.byteLength(out) <= maxBytes, `${Buffer.byteLength(out)} bytes`);
    assert.match(out, /passes\s*300\n?$/);
    assert.match(out, /not ok 1 - case 0/);
    assert.match(out, /\d+ failures before the tail were dropped to fit the size limit/);
  });

  it('is just the tail when nothing failed before it', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    assert.equal(logExcerpt(lines.join('\n'), { maxBytes: 64 * 1024 }), lines.slice(100).join('\n'));
  });
});
