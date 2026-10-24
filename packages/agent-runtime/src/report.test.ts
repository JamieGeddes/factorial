import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { MAX_REPORT_CHECKS, planStepIds, readAgentFile, reportProblem, stopHooks } from './report.ts';

const plan = JSON.stringify({ steps: [{ id: 'add-test' }, { id: 'reword' }] });
const report = (lines: string[]) => ['# Summary', '', 'Changed things.', '', '## Plan steps', ...lines, '', '## Notes', 'n'].join('\n');

describe('reportProblem', () => {
  it('accepts a section with a line per step, in any list style', () => {
    assert.equal(reportProblem(report(['- `add-test`: done', '2. **reword** skipped, already worded so']), ['add-test', 'reword']), undefined);
  });

  it('asks for a summary when there is none', () => {
    assert.match(reportProblem(undefined, ['add-test']) ?? '', /write \/workspace\/summary\.md/);
    assert.match(reportProblem('  \n', undefined) ?? '', /write \/workspace\/summary\.md/);
  });

  it('asks for the section, naming the steps, when it is missing', () => {
    const problem = reportProblem('Added a test. All steps done.', ['add-test', 'reword']);
    assert.match(problem ?? '', /no "## Plan steps" section.*add-test, reword/);
  });

  it('names only the steps without a line, and ignores lines outside the section', () => {
    const summary = report(['- add-test: done']) + '\n- reword: done';
    assert.match(reportProblem(summary, ['add-test', 'reword']) ?? '', /no line for reword\./);
  });

  it('does not take a step id for a longer one that starts with it', () => {
    assert.match(reportProblem(report(['- add-test-2: done']), ['add-test']) ?? '', /no line for add-test\./);
  });

  it('checks only that a summary exists when there is no readable plan', () => {
    assert.equal(reportProblem('Did the thing.', undefined), undefined);
  });
});

describe('planStepIds', () => {
  it('reads the ids, and refuses a plan with anything else', () => {
    assert.deepEqual(planStepIds(plan), ['add-test', 'reword']);
    assert.equal(planStepIds('{"steps":[{"id":"ok"},{"id":"not ok; rm -rf /"}]}'), undefined);
    assert.equal(planStepIds('not json'), undefined);
    assert.equal(planStepIds(undefined), undefined);
  });
});

describe('readAgentFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-'));

  it('reads a regular file up to the cap', () => {
    writeFileSync(path.join(dir, 'summary.md'), 'abcdef');
    assert.equal(readAgentFile(path.join(dir, 'summary.md'), 3), 'abc');
  });

  it('refuses a link, a FIFO and a missing file', () => {
    writeFileSync(path.join(dir, 'secret'), 'host only');
    symlinkSync(path.join(dir, 'secret'), path.join(dir, 'link.md'));
    execFileSync('mkfifo', [path.join(dir, 'fifo.md')]);
    assert.equal(readAgentFile(path.join(dir, 'link.md')), undefined);
    assert.equal(readAgentFile(path.join(dir, 'fifo.md')), undefined);
    assert.equal(readAgentFile(path.join(dir, 'absent.md')), undefined);
  });
});

describe('stopHooks', () => {
  const stop = { hook_event_name: 'Stop', stop_hook_active: false, session_id: 's', transcript_path: '', cwd: '/' } as unknown as HookInput;

  it('blocks while the report is incomplete, then lets the run end after the last check', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), plan);
    writeFileSync(path.join(workspace, 'summary.md'), 'Done.');
    const blocked: string[] = [];
    const [matcher] = stopHooks(workspace, (reason) => blocked.push(reason));
    const hook = matcher!.hooks[0]!;
    const signal = new AbortController().signal;
    for (let i = 0; i < MAX_REPORT_CHECKS; i += 1) {
      assert.equal((await hook(stop, undefined, { signal }) as SyncHookJSONOutput).decision, 'block');
    }
    assert.deepEqual(await hook(stop, undefined, { signal }), {});
    assert.equal(blocked.length, MAX_REPORT_CHECKS);
  });

  it('lets a complete report end the run, and ignores other events', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), plan);
    writeFileSync(path.join(workspace, 'summary.md'), report(['- add-test: done', '- reword: done']));
    const [matcher] = stopHooks(workspace, () => assert.fail('blocked'));
    const signal = new AbortController().signal;
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
    assert.deepEqual(await matcher!.hooks[0]!({ ...stop, hook_event_name: 'PreToolUse' } as HookInput, undefined, { signal }), {});
  });
});
