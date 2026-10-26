import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { MAX_REVIEW_BYTES, MAX_REVIEW_CHECKS, MIN_REVIEW_READS, READ_FURTHER, reviewErrors, reviewReadHooks, reviewStopHooks } from './review.ts';

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
    const [matcher] = reviewStopHooks(workspace, { count: MIN_REVIEW_READS }, (reason) => blocked.push(reason));
    for (let i = 0; i < MAX_REVIEW_CHECKS; i += 1) {
      const output = (await matcher!.hooks[0]!(stop, undefined, { signal })) as SyncHookJSONOutput;
      assert.equal(output.decision, 'block');
      assert.match(output.reason ?? '', /review\.json is missing/);
    }
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
    assert.equal(blocked.length, MAX_REVIEW_CHECKS);
  });

  it('lets a valid review that rests on enough reading end the run', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    writeFileSync(path.join(workspace, 'review.json'), review);
    const [matcher] = reviewStopHooks(workspace, { count: MIN_REVIEW_READS }, () => assert.fail('blocked'));
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
  });

  it('sends a valid review on too little reading back once, then lets it end', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    writeFileSync(path.join(workspace, 'review.json'), review);
    const blocked: string[] = [];
    const [matcher] = reviewStopHooks(workspace, { count: 1 }, (reason) => blocked.push(reason));
    const first = (await matcher!.hooks[0]!(stop, undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(first.decision, 'block');
    assert.equal(first.reason, READ_FURTHER);
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
    assert.deepEqual(blocked, [READ_FURTHER]);
  });

  it('asks for a valid review first, then for more reading', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    const reasons: string[] = [];
    const [matcher] = reviewStopHooks(workspace, { count: 0 }, (reason) => reasons.push(reason));
    await matcher!.hooks[0]!(stop, undefined, { signal });
    writeFileSync(path.join(workspace, 'review.json'), review);
    await matcher!.hooks[0]!(stop, undefined, { signal });
    assert.match(reasons[0] ?? '', /review\.json is missing/);
    assert.equal(reasons[1], READ_FURTHER);
  });
});

describe('reviewReadHooks', () => {
  const signal = new AbortController().signal;
  const call = (tool_name: string, tool_input: unknown) =>
    ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' }) as unknown as HookInput;

  it('counts every completed call except writing the review', async () => {
    const reads = { count: 0 };
    const [matcher] = reviewReadHooks('/workspace', reads);
    for (const input of [
      call('Bash', { command: 'git log -3' }),
      call('Read', { file_path: '/workspace/repo/a.ts' }),
      call('Grep', { pattern: 'x' }),
      call('Write', { file_path: '/workspace/review.json' }),
      call('Edit', { file_path: 'review.json' }),
    ]) {
      await matcher!.hooks[0]!(input, undefined, { signal });
    }
    assert.equal(reads.count, 3);
  });
});
