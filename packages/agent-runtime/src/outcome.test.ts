import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { outcomeOf } from './outcome.ts';

describe('outcomeOf', () => {
  it('maps every result subtype', () => {
    assert.equal(outcomeOf('success'), 'complete');
    assert.equal(outcomeOf('error_max_turns'), 'incomplete');
    assert.equal(outcomeOf('error_max_budget_usd'), 'incomplete');
    assert.equal(outcomeOf('error_during_execution'), 'failed');
    assert.equal(outcomeOf('error_max_structured_output_retries'), 'failed');
  });
});
