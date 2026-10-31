import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { validateOutcome, type Outcome } from './index.ts';

const examplesDir = new URL('../../../contracts/outcome/v1/examples/', import.meta.url);
const example = (name: string): Outcome => JSON.parse(readFileSync(new URL(name, examplesDir), 'utf8')) as Outcome;

function errorsOf(input: unknown): string[] {
  const result = validateOutcome(input);
  return result.ok ? [] : result.errors;
}

describe('the outcome contract', () => {
  for (const name of readdirSync(examplesDir)) {
    it(`accepts the example ${name}`, () => {
      assert.deepEqual(errorsOf(example(name)), []);
    });
  }

  it('accepts each result that needs nothing more than the pointers', () => {
    const base = example('failed-saved-work.json');
    for (const result of ['no-changes', 'tests-failed', 'invalid-plan', 'failed'] as const) {
      const { savedWork: _saved, ...rest } = base;
      assert.deepEqual(errorsOf({ ...rest, result }), [], result);
    }
  });

  it('accepts an outcome from before Intake chose a route', () => {
    const { threadKey: _t, route: _r, branch: _b, savedWork: _s, ...early } = example('failed-saved-work.json');
    assert.deepEqual(errorsOf(early), []);
  });

  it('requires a reason for a refusal and refuses one anywhere else', () => {
    const { reason: _reason, ...noReason } = example('refused.json');
    assert.notDeepEqual(errorsOf(noReason), []);
    assert.notDeepEqual(errorsOf({ ...example('failed-saved-work.json'), reason: 'busy' }), []);
  });

  it('requires the refuse route on a refusal', () => {
    assert.notDeepEqual(errorsOf({ ...example('refused.json'), route: 'change' }), []);
  });

  it('requires the pull request, branch and tested commit when one was opened or updated', () => {
    for (const field of ['pullRequest', 'branch', 'testedSha'] as const) {
      const opened = { ...example('pr-opened.json') } as Record<string, unknown>;
      delete opened[field];
      assert.notDeepEqual(errorsOf(opened), [], field);
    }
  });

  it('requires what an update continues', () => {
    const { inReplyTo: _i, ...updated } = example('pr-updated.json');
    assert.notDeepEqual(errorsOf(updated), []);
  });

  it('keeps the tested commit to an opened or updated pull request', () => {
    assert.notDeepEqual(errorsOf({ ...example('failed-saved-work.json'), testedSha: 'a'.repeat(40) }), []);
  });

  it('refuses saved work on a refusal or an opened pull request', () => {
    const savedWork = { branch: 'factorial/x' };
    assert.notDeepEqual(errorsOf({ ...example('refused.json'), savedWork }), []);
    assert.notDeepEqual(errorsOf({ ...example('pr-opened.json'), savedWork }), []);
  });

  it('refuses an unknown result, an unknown field and content', () => {
    assert.notDeepEqual(errorsOf({ ...example('pr-opened.json'), result: 'decomposed' }), []);
    assert.notDeepEqual(errorsOf({ ...example('pr-opened.json'), body: 'text' }), []);
    assert.notDeepEqual(errorsOf({ ...example('pr-opened.json'), source: { ...example('pr-opened.json').source, title: 'x' } }), []);
  });

  it('refuses an artefact prefix that is not an attempt prefix', () => {
    assert.notDeepEqual(errorsOf({ ...example('pr-opened.json'), artefactPrefix: 'elsewhere/' }), []);
  });
});
