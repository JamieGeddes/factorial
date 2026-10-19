import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { testResultArtefact } from './test-result.ts';

const id = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';

describe('testResultArtefact', () => {
  it('takes the run id from the run URL', () => {
    assert.deepEqual(
      testResultArtefact({
        sha: 'f'.repeat(40),
        runUrl: 'https://github.com/o/r/actions/runs/123456',
        outcome: 'success',
        workItemId: id,
      } as never),
      { sha: 'f'.repeat(40), runId: 123456, runUrl: 'https://github.com/o/r/actions/runs/123456', conclusion: 'success' },
    );
  });

  it('leaves out what the callback did not carry', () => {
    assert.deepEqual(testResultArtefact({ outcome: 'failure' }), { conclusion: 'failure' });
  });
});
