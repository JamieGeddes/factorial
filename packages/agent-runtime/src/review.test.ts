import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { MAX_REVIEW_BYTES, MAX_REVIEW_CHECKS, reviewErrors, reviewStopHooks } from './review.ts';

const review = JSON.stringify({
  schemaVersion: 1,
  verdict: 'approve',
  scores: { correctness: 5, completeness: 5, tests: 4, safety: 5 },
  findings: [{ path: 'src/a.ts', line: 3, severity: 'low', body: 'Name the constant.' }],
  summary: 'Does what was asked.',
});

describe('reviewErrors', () => {
  it('accepts a valid review', () => {
    assert.equal(reviewErrors(review), undefined);
  });

  it('reports a missing, oversized or invalid review', () => {
    assert.deepEqual(reviewErrors(undefined), ['/workspace/review.json is missing']);
    assert.match(reviewErrors(' '.repeat(MAX_REVIEW_BYTES + 1))?.[0] ?? '', /over 65536 bytes/);
    assert.match((reviewErrors(JSON.stringify({ ...JSON.parse(review), verdict: 'lgtm' })) ?? []).join('\n'), /^review\.json /);
    assert.ok(reviewErrors('{ not json'));
  });
});

describe('reviewStopHooks', () => {
  const stop = { hook_event_name: 'Stop', stop_hook_active: false, session_id: 's', transcript_path: '', cwd: '/' } as unknown as HookInput;
  const signal = new AbortController().signal;

  it('sends the reviewer back while the review is missing, at most MAX_REVIEW_CHECKS times', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    const blocked: string[] = [];
    const [matcher] = reviewStopHooks(workspace, (reason) => blocked.push(reason));
    for (let i = 0; i < MAX_REVIEW_CHECKS; i += 1) {
      const output = (await matcher!.hooks[0]!(stop, undefined, { signal })) as SyncHookJSONOutput;
      assert.equal(output.decision, 'block');
      assert.match(output.reason ?? '', /review\.json is missing/);
    }
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
    assert.equal(blocked.length, MAX_REVIEW_CHECKS);
  });

  it('lets a valid review end the run', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    writeFileSync(path.join(workspace, 'review.json'), review);
    const [matcher] = reviewStopHooks(workspace, () => assert.fail('blocked'));
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
  });
});
