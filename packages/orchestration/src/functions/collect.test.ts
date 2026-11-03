import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  LEFTOVER_COMMIT_MESSAGE,
  SALVAGE_COMMIT_MESSAGE,
  bundleScript,
  collect,
  inspectScript,
  leftoverMessage,
  parseInspection,
  roundStartFor,
  touchesWorkflows,
} from './collect.ts';
import type { CleanRoomPush } from '../lib/clean-room.ts';
import type { WorkContext } from '../lib/context.ts';
import type { Logger } from '../lib/log.ts';
import { InvalidPlanError } from '../lib/plan-files.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;

const SECTION = '\n===FACTORIAL-SECTION===\n';
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);

describe('parseInspection', () => {
  it("extracts the round's and the item's commit counts, head sha, changed paths and summary", () => {
    const out = `3\n${SECTION}${sha}\n${SECTION}README.md\n.github/workflows/ci.yml\n${SECTION}5\n${SECTION}# Summary\n\nDid the thing.\n`;
    assert.deepEqual(parseInspection(out), {
      commitCount: 3,
      itemCommitCount: 5,
      headSha: sha,
      changedPaths: ['README.md', '.github/workflows/ci.yml'],
      summary: '# Summary\n\nDid the thing.',
    });
  });

  it('tolerates no changed paths and a missing summary', () => {
    assert.deepEqual(parseInspection(`0\n${SECTION}${sha}\n${SECTION}\n${SECTION}0\n${SECTION}`), {
      commitCount: 0,
      itemCommitCount: 0,
      headSha: sha,
      changedPaths: [],
      summary: '',
    });
  });

  it('rejects malformed output', () => {
    assert.throws(() => parseInspection('garbage'), /Could not parse/);
    assert.throws(() => parseInspection(`x${SECTION}${sha}${SECTION}`), /Could not parse/);
    assert.throws(() => parseInspection(`3\n${SECTION}${sha}\n${SECTION}\n${SECTION}`), /Could not parse/);
  });

  it('keeps a summary that contains the section marker whole', () => {
    const summary = `before${SECTION}after`;
    assert.equal(parseInspection(`1\n${SECTION}${sha}\n${SECTION}\n${SECTION}1\n${SECTION}${summary}`).summary, summary.trim());
  });
});

describe('a round that stopped at the builder\'s limit', () => {
  it('is told apart from a failure by the invoker exit code in the task failure', async () => {
    const { builderIncomplete } = await import('../lib/incomplete.ts');
    const cause = (exitCode: number) => JSON.stringify({ Containers: [{ Name: 'invoker', ExitCode: exitCode }] });
    assert.equal(builderIncomplete({ Error: 'States.TaskFailed', Cause: cause(3) }), true);
    assert.equal(builderIncomplete({ Error: 'States.TaskFailed', Cause: cause(1) }), false);
    assert.equal(builderIncomplete(null), false);
  });
});

describe('touchesWorkflows', () => {
  it('is true only for files under .github/workflows/', () => {
    assert.equal(touchesWorkflows(['.github/workflows/ci.yml', 'README.md']), true);
    assert.equal(touchesWorkflows(['.github/CODEOWNERS', 'docs/workflows.md', 'packages/x/.github/workflows/y.yml']), false);
    assert.equal(touchesWorkflows([]), false);
  });
});

describe('agent-session scripts carry no credentials', () => {
  it('inspects with hooks disabled and commits leftovers first', () => {
    const script = inspectScript(base);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1/);
    assert.match(script, new RegExp(`git rev-list --count '${base}'\\.\\.HEAD`));
    assert.ok(script.indexOf('add -A') < script.indexOf('git rev-list'));
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
    assert.ok(script.includes(`commit --quiet -m '${LEFTOVER_COMMIT_MESSAGE}'`));
  });

  it('labels leftovers as saved work in progress after a failed build', () => {
    const script = inspectScript(base, SALVAGE_COMMIT_MESSAGE);
    assert.ok(script.includes(`commit --quiet -m 'Save work in progress after the build failed'`));
  });

  it('names leftovers for how the build ended: failed, at its limit, or finished', () => {
    assert.equal(leftoverMessage(true, false), SALVAGE_COMMIT_MESSAGE);
    assert.equal(leftoverMessage(true, true), 'Save work in progress when the builder reached its limit');
    assert.equal(leftoverMessage(false, false), LEFTOVER_COMMIT_MESSAGE);
  });

  it("counts the round's commits from its start and the item's from the item's base", () => {
    const itemBase = 'c'.repeat(40);
    const script = inspectScript(base, LEFTOVER_COMMIT_MESSAGE, itemBase);
    assert.match(script, new RegExp(`git rev-list --count '${base}'\\.\\.HEAD`));
    assert.match(script, new RegExp(`git rev-list --count '${itemBase}'\\.\\.HEAD`));
    assert.throws(() => inspectScript(base, LEFTOVER_COMMIT_MESSAGE, 'nope'), /work item base commit/);
  });

  it('bundles only the new commits, pins the head and caps the size', () => {
    const script = bundleScript(base, sha);
    assert.match(script, new RegExp(`test \"\\$\\(git rev-parse HEAD\\)\" = '${sha}'`));
    assert.match(script, new RegExp(`bundle create /tmp/factorial\\.bundle '${base}'\\.\\.HEAD`));
    assert.match(script, /bundle too large/);
    assert.match(script, /base64 -w0 \/tmp\/factorial\.bundle$/m);
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
    assert.throws(() => bundleScript(base, 'nope'), /not a commit sha/);
  });
});

describe('roundStartFor', () => {
  const ctx = (extra: Partial<WorkContext> = {}): WorkContext =>
    ({ workItem: { id: 'w', context: undefined }, baseCommit: base, ...extra }) as unknown as WorkContext;

  it('starts round 1 at the base commit, on a new branch', () => {
    assert.deepEqual(roundStartFor(ctx(), undefined), { commit: base, existing: false, pushed: false });
    assert.deepEqual(roundStartFor(ctx(), null), { commit: base, existing: false, pushed: false });
  });

  it('starts round 1 on the existing branch for rework or a resumed attempt', () => {
    const rework = ctx({ rework: { pullRequest: { number: 26, url: 'https://x' }, cause: 'review', previousWorkItemId: 'p', baseBranch: 'main' } });
    assert.equal(roundStartFor(rework, undefined).existing, true);
    const resumed = ctx({ resumedFrom: { workItemId: 'a', status: 'failed', savedWork: true, branch: 'factorial/a' } });
    assert.equal(roundStartFor(resumed, undefined).existing, true);
  });

  it("starts a resumed attempt's round 1 as pushed, since its branch holds the earlier attempt's work, but not a rework's", () => {
    const resumed = ctx({ resumedFrom: { workItemId: 'a', status: 'tests-failed', branch: 'factorial/a' } });
    assert.deepEqual(roundStartFor(resumed, undefined), { commit: base, existing: true, pushed: true });
    const rework = ctx({ rework: { pullRequest: { number: 26, url: 'https://x' }, cause: 'review', previousWorkItemId: 'p', baseBranch: 'main' } });
    assert.equal(roundStartFor(rework, undefined).pushed, false);
  });

  it("starts a later round where ContinueBuild says, the previous round's pushed head", () => {
    assert.deepEqual(roundStartFor(ctx(), { commit: sha, existing: true, pushed: true }), { commit: sha, existing: true, pushed: true });
  });

  it('refuses a round start that is not a commit sha', () => {
    assert.throws(() => roundStartFor(ctx(), { commit: 'HEAD; rm -rf /', existing: true, pushed: true }), /not a commit sha/);
  });
});

describe('collect pushes from its own clean room and stops the builder session', () => {
  const WORK_ITEM_ID = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
  const pushed = 'c'.repeat(40);
  const ENV = { BUILDER_RUNTIME_ARN: 'arn:builder', REVIEWER_RUNTIME_ARN: 'arn:reviewer', RUNTIME_QUALIFIER: 'live', ARTEFACT_BUCKET: 'bucket', TABLE_NAME: 'table' };
  const ctx = {
    workItem: { id: WORK_ITEM_ID, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
    sessionId: WORK_ITEM_ID,
    branch: 'factorial/x',
    baseBranch: 'main',
    baseCommit: base,
    attempt: 1,
    artefactPrefix: `${WORK_ITEM_ID}/1/`,
  } as unknown as WorkContext;
  /** What the clean-room push was given; it runs in the Lambda, so no session sees it. */
  let pushes: CleanRoomPush[];
  const deps = {
    commitIdentity: async () => ({ name: 'Factorial', email: 'f@example.invalid' }),
    repositoryToken: async () => TOKEN,
    push: async (params: CleanRoomPush) => {
      pushes.push(params);
      events.push('push');
      if (failOn === 'push') throw new Error('push failed');
      return pushed;
    },
  };
  const log = { info: () => {}, error: () => {}, with: () => log } as Logger;

  /** What the sessions answer, in order of the calls, and what was stopped. */
  let events: string[];
  let saved: Record<string, string | undefined>;
  /** Makes the session command whose script contains `marker` throw. */
  let failOn: string | undefined;
  let failStop: boolean;
  let commits: number;
  /** What the plan read answers: no plan files unless a test supplies valid ones. */
  let planReply: string;

  const reply = (stdout: string, exitCode = 0) => ({ stream: [{ chunk: { contentDelta: { stdout } } }, { chunk: { contentStop: { exitCode } } }] });

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, ENV);
    events = [];
    pushes = [];
    failOn = undefined;
    failStop = false;
    commits = 2;
    planReply = 'missing:\n===FACTORIAL-PLAN===\nmissing:';
    mock.method(S3Client.prototype, 'send', async () => ({}));
    mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({}));
    mock.method(BedrockAgentCoreClient.prototype, 'send', async (command: unknown) => {
      if (command instanceof StopRuntimeSessionCommand) {
        events.push(`stop ${command.input.runtimeSessionId}`);
        if (failStop) throw new Error('stop denied');
        return {};
      }
      assert.ok(command instanceof InvokeAgentRuntimeCommandCommand);
      const script = command.input.body?.command ?? '';
      if (failOn && script.includes(failOn)) throw new Error(`${failOn} failed`);
      if (script.includes('status --porcelain')) return reply(`${commits}\n${SECTION}${sha}\n${SECTION}a.txt\n${SECTION}${commits}\n${SECTION}Did it.`);
      if (script.includes('bundle create')) {
        events.push('bundle');
        return reply('QUJD');
      }
      if (script.includes('FACTORIAL-PLAN')) return reply(planReply);
      return reply('');
    });
  });
  afterEach(() => {
    mock.restoreAll();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('does not read the verifiers when salvaging: saved work goes to ContinueBuild or a report, never to Verify', async () => {
    let asked = 0;
    const result = await collect({ ...ctx, salvage: true }, log, { ...deps, readFile: async () => ((asked += 1), undefined) });
    assert.equal(asked, 0);
    assert.equal(result.verify, undefined);
  });

  it('pushes the exported bundle from the Lambda, with no second session, and stops the builder session before returning', async () => {
    const result = await collect({ ...ctx, salvage: true }, log, deps);
    assert.equal(result.headSha, pushed);
    assert.deepEqual(events, ['bundle', 'push', `stop ${WORK_ITEM_ID}`]);
    assert.equal(pushes.length, 1);
    const [push] = pushes;
    assert.equal(push?.remoteUrl, 'https://github.com/JamieGeddes/factorial.git');
    assert.equal(push?.branch, 'factorial/x');
    assert.equal(push?.baseCommit, base);
    assert.equal(push?.headSha, sha);
    assert.equal(push?.existingBranch, false);
    assert.equal(push?.token, TOKEN);
    assert.deepEqual(Buffer.from(push?.bundle ?? []), Buffer.from('ABC'));
  });

  it('pushes a rework onto the existing branch from the head its session started at', async () => {
    const started = 'd'.repeat(40);
    await collect({ ...ctx, salvage: true, roundStart: { commit: started, existing: true, pushed: false } }, log, deps);
    assert.equal(pushes[0]?.existingBranch, true);
    assert.equal(pushes[0]?.baseCommit, started);
  });

  it('stops the round\'s own session, not the work item\'s', async () => {
    await collect({ ...ctx, salvage: true, builderSessionId: `${WORK_ITEM_ID}-round-2` }, log, deps);
    assert.ok(events.includes(`stop ${WORK_ITEM_ID}-round-2`));
    assert.ok(!events.includes(`stop ${WORK_ITEM_ID}`));
  });

  it('stops only the builder session when the agent made no commits', async () => {
    commits = 0;
    const result = await collect({ ...ctx, salvage: true }, log, deps);
    assert.equal(result.pushed, false);
    assert.deepEqual(events, [`stop ${WORK_ITEM_ID}`]);
  });

  it('stops only the builder session when earlier rounds pushed and this one added nothing', async () => {
    commits = 0;
    const result = await collect({ ...ctx, salvage: true, roundStart: { commit: pushed, existing: true, pushed: true } }, log, deps);
    assert.equal(result.pushed, true);
    assert.deepEqual(events, [`stop ${WORK_ITEM_ID}`]);
  });

  it("keeps a resumed attempt's branch head as the result when the agent added nothing, so it is tested rather than reported as no changes", async () => {
    commits = 0;
    const resumedFrom = { workItemId: 'a', status: 'tests-failed', branch: 'factorial/x' };
    const result = await collect({ ...ctx, resumedFrom, salvage: true }, log, deps);
    assert.equal(result.pushed, true);
    assert.equal(result.headSha, base);
    assert.equal(pushes.length, 0);
    assert.deepEqual(events, [`stop ${WORK_ITEM_ID}`]);
  });

  it('sends a finished resumed attempt that added nothing to Verify, at the branch head', async () => {
    commits = 0;
    const json = await readFile(new URL('../../../../contracts/plan/v1/examples/single-change.json', import.meta.url), 'utf8');
    const encoded = (text: string) => `ok:${Buffer.byteLength(text)}:${Buffer.from(text).toString('base64')}`;
    planReply = `${encoded('# Plan\n')}\n===FACTORIAL-PLAN===\n${encoded(json)}`;
    const resumedFrom = { workItemId: 'a', status: 'tests-failed', branch: 'factorial/x' };
    const asked: string[] = [];
    const result = await collect({ ...ctx, resumedFrom }, log, { ...deps, readFile: async (_repo, path, ref) => (asked.push(`${ref}:${path}`), undefined) });
    assert.equal(result.pushed, true);
    assert.equal(result.headSha, base);
    // The base branch, never the work branch: the builder cannot remove the gate.
    assert.deepEqual(asked, ['main:.factorial/verifiers.json']);
    assert.deepEqual(result.verify, { skipped: 'JamieGeddes/factorial declares no verifiers (no .factorial/verifiers.json on main)' });
    assert.equal(pushes.length, 0);
  });

  it('reports a rework turn that added nothing as no changes', async () => {
    commits = 0;
    const rework = { pullRequest: { number: 26, url: 'https://x' }, cause: 'review', previousWorkItemId: 'p', baseBranch: 'main' };
    const result = await collect({ ...ctx, rework, salvage: true } as typeof ctx, log, deps);
    assert.equal(result.pushed, false);
  });

  it('stops nothing when the inspection fails, so the retry finds the session', async () => {
    failOn = 'status --porcelain';
    await assert.rejects(collect({ ...ctx, salvage: true }, log, deps), /status --porcelain failed/);
    assert.deepEqual(events, []);
  });

  it('stops nothing when the plan is invalid, which ends the item', async () => {
    await assert.rejects(collect({ ...ctx }, log, deps), InvalidPlanError);
    assert.deepEqual(events, []);
  });

  it('stops nothing when the push fails', async () => {
    failOn = 'push';
    await assert.rejects(collect({ ...ctx, salvage: true }, log, deps), /push failed/);
    assert.deepEqual(events, ['bundle', 'push']);
  });

  it('still succeeds when a stop fails', async () => {
    failStop = true;
    const result = await collect({ ...ctx, salvage: true }, log, deps);
    assert.equal(result.headSha, pushed);
    assert.deepEqual(events, ['bundle', 'push', `stop ${WORK_ITEM_ID}`]);
  });
});
