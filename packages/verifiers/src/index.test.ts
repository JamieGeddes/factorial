import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERIFIERS_FILE, parseVerifierResult, parseVerifierSettings, validateVerifierResult, outcomeOf, verifierPath } from './index.ts';

const examplesDir = fileURLToPath(new URL('../../../contracts/verifiers/v1/examples/', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));

const settings = (verifiers: unknown[]): string => JSON.stringify({ schemaVersion: 1, verifiers });
const checks = { name: 'checks', kind: 'command', run: 'npm test', required: true, timeoutSeconds: 600 };

describe('verifier settings', () => {
  it("accepts the example and Factorial's own file", async () => {
    for (const file of [path.join(examplesDir, 'verifiers.json'), path.join(repository, VERIFIERS_FILE)]) {
      const result = parseVerifierSettings(await readFile(file, 'utf8'));
      assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    }
  });

  it('accepts a timeout of two hours', () => {
    assert.equal(parseVerifierSettings(settings([{ ...checks, timeoutSeconds: 7200 }])).ok, true);
  });

  it('refuses a name used twice, naming the later entry', () => {
    const result = parseVerifierSettings(settings([checks, { ...checks, required: false }]));
    assert.deepEqual(result, { ok: false, errors: ['/verifiers/1/name "checks" is used by an earlier verifier'] });
  });

  it('refuses an empty list, an unknown kind, a name that is not a path segment and a timeout over the cap', () => {
    assert.equal(parseVerifierSettings(settings([])).ok, false);
    assert.equal(parseVerifierSettings(settings([{ ...checks, kind: 'sandbox' }])).ok, false);
    assert.equal(parseVerifierSettings(settings([{ ...checks, name: '../x' }])).ok, false);
    assert.equal(parseVerifierSettings(settings([{ ...checks, timeoutSeconds: 7201 }])).ok, false);
    assert.equal(parseVerifierSettings(settings([{ ...checks, extra: true }])).ok, false);
  });

  it('reports a syntax error and an oversized file as problems, not exceptions', () => {
    const syntax = parseVerifierSettings('{');
    assert.equal(syntax.ok, false);
    assert.match(syntax.ok ? '' : syntax.errors[0]!, /not valid JSON/);
    const large = parseVerifierSettings(' '.repeat(65 * 1024));
    assert.match(large.ok ? '' : large.errors[0]!, /over 65536 bytes/);
  });
});

describe('verifier result', () => {
  it('accepts every result example', async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.startsWith('result-'));
    assert.ok(files.length > 0);
    for (const file of files) {
      const result = parseVerifierResult(await readFile(path.join(examplesDir, file), 'utf8'));
      assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    }
  });

  it('refuses an unknown outcome and a short sha', async () => {
    const example = JSON.parse(await readFile(path.join(examplesDir, 'result-passed.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(validateVerifierResult({ ...example, outcome: 'skipped' }).ok, false);
    assert.equal(validateVerifierResult({ ...example, sha: 'abc' }).ok, false);
  });
});

describe('paths', () => {
  it("puts a verifier's files under verify/<name>/", () => {
    assert.equal(verifierPath('checks', 'result.json'), 'verify/checks/result.json');
  });
});

describe('outcomeOf', () => {
  it('reads exit statuses', () => {
    assert.deepEqual(outcomeOf(0, 5, 600), { outcome: 'passed' });
    assert.equal(outcomeOf(1, 5, 600).outcome, 'failed');
    assert.equal(outcomeOf(124, 600, 600).outcome, 'timed-out');
    assert.equal(outcomeOf(137, 631, 600).outcome, 'timed-out');
    assert.equal(outcomeOf(137, 20, 600).outcome, 'failed');
    assert.equal(outcomeOf(125, 1, 600).outcome, 'error');
    assert.equal(outcomeOf(127, 1, 600).outcome, 'error');
    assert.equal(outcomeOf(-1, 1, 600).outcome, 'error');
  });
});
