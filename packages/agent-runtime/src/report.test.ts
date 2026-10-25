import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { MAX_PLAN_REJECTIONS, MAX_REPORT_CHECKS, PLAN_GATE_CLOSED, planBrief, planErrors, planHooks, planStepIds, readAgentFile, reportProblem, stopHooks } from './report.ts';

const planStep = (id: string) => ({ id, description: `Do ${id}.`, files: ['src/a.ts'], verification: 'npm test passes' });
const plan = JSON.stringify({
  schemaVersion: 1,
  summary: 'Add a test and reword.',
  steps: [planStep('add-test'), planStep('reword')],
  tests: { run: ['npm test'], add: [] },
  risks: [],
  openQuestions: [],
});
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
    assert.match(problem ?? '', /<id>: done\|skipped\|changed:/);
    assert.match(problem ?? '', /## Behaviour impact/);
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

describe('planBrief', () => {
  const step = { id: 'verify-ci', description: 'Run the checks. Commit only if one fails.', files: [], verification: 'npm run ci passes' };

  it('lists every step in order with its description, files and verification', () => {
    const brief = planBrief(JSON.stringify({ steps: [step, { ...step, id: 'add-test', files: ['src/a.test.ts'] }] })) ?? '';
    assert.match(brief, /^## The plan's steps\n/);
    assert.match(brief, /### 1\. `verify-ci`\n\nRun the checks\. Commit only if one fails\.\n\nFiles: none listed\nVerification: npm run ci passes/);
    assert.match(brief, /### 2\. `add-test`[\s\S]*Files: `src\/a\.test\.ts`/);
  });

  it('is undefined for a missing, unparseable or malformed plan', () => {
    assert.equal(planBrief(undefined), undefined);
    assert.equal(planBrief('{'), undefined);
    assert.equal(planBrief(JSON.stringify({ steps: [] })), undefined);
    assert.equal(planBrief(JSON.stringify({ steps: [{ ...step, verification: 1 }] })), undefined);
    assert.equal(planBrief(JSON.stringify({ steps: [{ ...step, id: '../x' }] })), undefined);
  });
});

describe('planErrors', () => {
  it('accepts a plan that meets the contract', () => {
    assert.equal(planErrors(plan), undefined);
  });

  it('names what is wrong, a missing file included', () => {
    assert.deepEqual(planErrors(undefined), ['/workspace/plan.json is missing']);
    assert.match(planErrors('{')?.[0] ?? '', /^plan\.json \(root\) is not valid JSON/);
    assert.ok(planErrors(JSON.stringify({ ...JSON.parse(plan), steps: [] }))?.some((e) => e.includes('/steps')));
  });
});

describe('planHooks', () => {
  const signal = new AbortController().signal;
  const write = (workspace: string, file: string) =>
    ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(workspace, file) }, tool_response: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' }) as unknown as HookInput;

  it('passes a valid plan and ignores other files', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), plan);
    const [matcher] = planHooks(workspace, { closed: false }, () => assert.fail('rejected'));
    assert.equal(matcher!.matcher, 'Write|Edit');
    assert.deepEqual(await matcher!.hooks[0]!(write(workspace, 'plan.json'), undefined, { signal }), {});
    writeFileSync(path.join(workspace, 'notes.md'), '{');
    assert.deepEqual(await matcher!.hooks[0]!(write(workspace, 'notes.md'), undefined, { signal }), {});
  });

  it('sends an invalid plan back with its errors, then closes the gate', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), '{"steps":[]}');
    const gate = { closed: false };
    const rejected: boolean[] = [];
    const [matcher] = planHooks(workspace, gate, (_errors, closed) => rejected.push(closed));
    const first = (await matcher!.hooks[0]!(write(workspace, 'plan.json'), undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(first.decision, 'block');
    assert.match(first.reason ?? '', /does not meet the plan contract[\s\S]*- plan\.json/);
    assert.equal(gate.closed, false);
    for (let i = 1; i < MAX_PLAN_REJECTIONS - 1; i += 1) await matcher!.hooks[0]!(write(workspace, 'plan.json'), undefined, { signal });
    const last = (await matcher!.hooks[0]!(write(workspace, 'plan.json'), undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(gate.closed, true);
    assert.equal(last.reason, PLAN_GATE_CLOSED);
    assert.deepEqual(rejected.at(-1), true);
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
    const [matcher] = stopHooks(workspace, { closed: false }, (reason) => blocked.push(reason));
    const hook = matcher!.hooks[0]!;
    const signal = new AbortController().signal;
    for (let i = 0; i < MAX_REPORT_CHECKS; i += 1) {
      assert.equal((await hook(stop, undefined, { signal }) as SyncHookJSONOutput).decision, 'block');
    }
    assert.deepEqual(await hook(stop, undefined, { signal }), {});
    assert.equal(blocked.length, MAX_REPORT_CHECKS);
  });

  it('blocks a run that has no valid plan', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'summary.md'), report(['- add-test: done']));
    const [matcher] = stopHooks(workspace, { closed: false }, () => {});
    const output = (await matcher!.hooks[0]!(stop, undefined, { signal: new AbortController().signal })) as SyncHookJSONOutput;
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /plan\.json is missing/);
  });

  it('lets the run end once the plan gate has closed', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    const [matcher] = stopHooks(workspace, { closed: true }, () => assert.fail('blocked'));
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal: new AbortController().signal }), {});
  });

  it('lets a complete report end the run, and ignores other events', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), plan);
    writeFileSync(path.join(workspace, 'summary.md'), report(['- add-test: done', '- reword: done']));
    const [matcher] = stopHooks(workspace, { closed: false }, () => assert.fail('blocked'));
    const signal = new AbortController().signal;
    assert.deepEqual(await matcher!.hooks[0]!(stop, undefined, { signal }), {});
    assert.deepEqual(await matcher!.hooks[0]!({ ...stop, hook_event_name: 'PreToolUse' } as HookInput, undefined, { signal }), {});
  });
});
