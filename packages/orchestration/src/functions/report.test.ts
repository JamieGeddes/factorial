import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportMessage } from './report.ts';

describe('reportMessage', () => {
  it('explains a no-change outcome and includes the agent summary', () => {
    const text = reportMessage({ status: 'no-changes', summary: 'Nothing to do.' });
    assert.match(text, /made no changes/);
    assert.match(text, /Nothing to do\./);
  });

  it('links the failed test run when the cause carries it', () => {
    const text = reportMessage({
      status: 'tests-failed',
      error: { Error: 'TestsFailed', Cause: JSON.stringify({ runUrl: 'https://x/run/9' }) },
    });
    assert.match(text, /\[run\]\(https:\/\/x\/run\/9\)/);
  });

  it('survives a non-JSON cause', () => {
    const text = reportMessage({ status: 'tests-failed', error: { Error: 'TestsFailed', Cause: 'boom' } });
    assert.match(text, /did not pass/);
  });

  it('truncates long failure causes', () => {
    const text = reportMessage({ status: 'failed', error: { Error: 'States.Timeout', Cause: 'x'.repeat(5000) } });
    assert.ok(text.length < 1700);
    assert.match(text, /States\.Timeout/);
  });
});
