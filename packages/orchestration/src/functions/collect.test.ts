import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  LEFTOVER_COMMIT_MESSAGE,
  SALVAGE_COMMIT_MESSAGE,
  bundleScript,
  collect,
  cleanRoomPushScript,
  inspectScript,
  leftoverMessage,
  parseInspection,
  roundStartFor,
  testSkipReason,
  touchesWorkflows,
} from './collect.ts';
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

describe('cleanRoomPushScript', () => {
  const identity = { name: 'factorial-x[bot]', email: '12345+factorial-x[bot]@users.noreply.github.com' };
  const params = {
    owner: 'JamieGeddes',
    name: 'factorial',
    branch: 'factorial/abc',
    baseBranch: 'main',
    baseCommit: base,
    headSha: sha,
    existingBranch: true,
    token: TOKEN,
    bundleBase64: 'QUJD',
    identity,
  };

  it('imports the bundle into a pristine clone, verifies the head and pushes exactly that commit', () => {
    const script = cleanRoomPushScript(params);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.match(script, /printf '%s' 'QUJD' \| base64 -d > incoming\.bundle/);
    assert.match(script, new RegExp(`clone --quiet --bare --filter=blob:none 'https://github\\.com/JamieGeddes/factorial\\.git' repo\\.git`));
    assert.match(script, /fetch --quiet \.\.\/incoming\.bundle HEAD/);
    // clone, bundle import (lazy blob fetch from origin) and push all authenticate
    assert.equal(script.split('http.extraHeader=').length - 1, 3);
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse FETCH_HEAD\\)" = '${sha}'`));
    assert.match(script, /push --quiet origin "\$new:refs\/heads\/factorial\/abc"/);
    assert.match(script, /echo "\$new"$/);
    assert.match(script, new RegExp(`http\\.extraHeader='AUTHORIZATION: basic ${basic}'`));
    assert.doesNotMatch(script, /ghs_t/);
    assert.doesNotMatch(script, /x-access-token:ghs/);
    assert.ok(script.split('core.hooksPath=/dev/null').length >= 4, 'every git call that could run hooks disables them');
  });

  it('re-creates every commit with the App identity, keeping trees, messages and author dates', () => {
    const script = cleanRoomPushScript(params);
    assert.match(script, new RegExp(`base='${base}'`));
    assert.match(script, /test -z "\$\(git rev-list --merges "\$base\.\.FETCH_HEAD"\)"/);
    assert.match(script, /for c in \$\(git rev-list --reverse "\$base\.\.FETCH_HEAD"\); do/);
    assert.match(script, /GIT_AUTHOR_NAME='factorial-x\[bot\]' GIT_AUTHOR_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com' GIT_COMMITTER_NAME='factorial-x\[bot\]' GIT_COMMITTER_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com'/);
    assert.match(script, /GIT_AUTHOR_DATE="\$\(git log -1 --format=%aI "\$c"\)" git commit-tree "\$c\^\{tree\}" -p "\$new"/);
    // the rewrite happens after the head check and before the push
    assert.ok(script.indexOf('rev-parse FETCH_HEAD') < script.indexOf('commit-tree'));
    assert.ok(script.indexOf('commit-tree') < script.indexOf('push --quiet'));
  });

  it('pushes only on top of the branch head the session started from, as a fast-forward', () => {
    const script = cleanRoomPushScript(params);
    // the branch must still point at the base commit; anything else fails
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse --verify --quiet refs/heads/factorial/abc\\)" = '${base}'`));
    // and the agent's head must descend from it, so the push is a fast-forward
    assert.match(script, new RegExp(`git merge-base --is-ancestor '${base}' FETCH_HEAD`));
    // never a force push
    assert.doesNotMatch(script, /--force|-f refs|push -f/);
    // the ancestry check happens before the rewrite and the push
    assert.ok(script.indexOf('merge-base --is-ancestor') < script.indexOf('commit-tree'));
    assert.ok(script.indexOf('merge-base --is-ancestor') < script.indexOf('push --quiet'));
  });

  it('requires a fresh branch not to exist yet, so the push never overwrites one', () => {
    const script = cleanRoomPushScript({ ...params, existingBranch: false });
    assert.match(script, /test -z "\$\(git rev-parse --verify --quiet refs\/heads\/factorial\/abc\)"/);
    assert.doesNotMatch(script, /rev-parse --verify --quiet refs\/heads\/factorial\/abc\)" =/);
    // the agent's head must still descend from the base commit
    assert.match(script, new RegExp(`git merge-base --is-ancestor '${base}' FETCH_HEAD`));
  });

  it('rejects an identity or branch that could break out of the shell command', () => {
    assert.throws(() => cleanRoomPushScript({ ...params, identity: { ...identity, name: "x'; rm -rf /" } }), /unexpected format/);
    assert.throws(() => cleanRoomPushScript({ ...params, identity: { ...identity, email: 'a b@c' } }), /unexpected format/);
    assert.throws(() => cleanRoomPushScript({ ...params, baseBranch: 'main;ls' }), /not a valid branch name/);
    assert.throws(() => cleanRoomPushScript({ ...params, branch: '../x' }), /not a valid branch name/);
  });

  it('rejects bad names and shas before building anything', () => {
    assert.throws(() => cleanRoomPushScript({ ...params, owner: 'bad owner' }), /not a valid GitHub name/);
    assert.throws(() => cleanRoomPushScript({ ...params, headSha: 'short' }), /not a commit sha/);
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

  it("starts a later round where ContinueBuild says, the previous round's pushed head", () => {
    assert.deepEqual(roundStartFor(ctx(), { commit: sha, existing: true, pushed: true }), { commit: sha, existing: true, pushed: true });
  });

  it('refuses a round start that is not a commit sha', () => {
    assert.throws(() => roundStartFor(ctx(), { commit: 'HEAD; rm -rf /', existing: true, pushed: true }), /not a commit sha/);
  });
});

describe('testSkipReason', () => {
  const repo = { owner: 'JamieGeddes', name: 'other' };
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TEST_WORKFLOW_FILE;
    process.env.TEST_WORKFLOW_FILE = 'test.yml';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_WORKFLOW_FILE;
    else process.env.TEST_WORKFLOW_FILE = saved;
  });

  it("is undefined when the base branch has the test workflow, so Test runs", async () => {
    const asked: string[] = [];
    assert.equal(await testSkipReason(repo, 'main', async (_r, path, ref) => (asked.push(`${ref}:${path}`), true)), undefined);
    // The base branch, never the work branch: the builder cannot remove the gate.
    assert.deepEqual(asked, ['main:.github/workflows/test.yml']);
  });

  it('names the missing workflow and the branch when there is none, so Test is skipped', async () => {
    assert.equal(await testSkipReason(repo, 'main', async () => false), 'JamieGeddes/other has no .github/workflows/test.yml on main');
  });

  it('fails Collect rather than skipping when GitHub cannot say', async () => {
    await assert.rejects(testSkipReason(repo, 'main', async () => { throw new Error('GitHub GET failed: 403'); }), /403/);
  });
});

describe('collect stops the sessions it has finished with', () => {
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
  const deps = { commitIdentity: async () => ({ name: 'Factorial', email: 'f@example.invalid' }), repositoryToken: async () => TOKEN };
  const log = { info: () => {}, error: () => {}, with: () => log } as Logger;

  /** What the sessions answer, in order of the calls, and what was stopped. */
  let events: string[];
  let saved: Record<string, string | undefined>;
  /** Makes the session command whose script contains `marker` throw. */
  let failOn: string | undefined;
  let failStop: boolean;
  let commits: number;

  const reply = (stdout: string, exitCode = 0) => ({ stream: [{ chunk: { contentDelta: { stdout } } }, { chunk: { contentStop: { exitCode } } }] });

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, ENV);
    events = [];
    failOn = undefined;
    failStop = false;
    commits = 2;
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
      if (script.includes('push --quiet')) {
        events.push(`push ${command.input.runtimeSessionId}`);
        return reply(`${pushed}\n`);
      }
      if (script.includes('FACTORIAL-PLAN')) return reply('missing:\n===FACTORIAL-PLAN===\nmissing:');
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

  it('does not look for the test workflow when salvaging: saved work goes to ContinueBuild or a report, never to Test', async () => {
    let asked = 0;
    const result = await collect({ ...ctx, salvage: true }, log, { ...deps, fileExists: async () => (asked += 1) > 0 });
    assert.equal(asked, 0);
    assert.equal(result.testSkipReason, undefined);
  });

  it('stops the clean room after the push and the builder session before returning', async () => {
    const result = await collect({ ...ctx, salvage: true }, log, deps);
    assert.equal(result.headSha, pushed);
    assert.deepEqual(events, ['bundle', `push ${WORK_ITEM_ID}-push`, `stop ${WORK_ITEM_ID}-push`, `stop ${WORK_ITEM_ID}`]);
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
    failOn = 'push --quiet';
    await assert.rejects(collect({ ...ctx, salvage: true }, log, deps), /push --quiet failed/);
    assert.deepEqual(events, ['bundle']);
  });

  it('still succeeds when a stop fails', async () => {
    failStop = true;
    const result = await collect({ ...ctx, salvage: true }, log, deps);
    assert.equal(result.headSha, pushed);
    assert.deepEqual(events, [`bundle`, `push ${WORK_ITEM_ID}-push`, `stop ${WORK_ITEM_ID}-push`, `stop ${WORK_ITEM_ID}`]);
  });
});
