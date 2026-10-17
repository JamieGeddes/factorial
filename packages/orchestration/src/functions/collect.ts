/**
 * Collect: after the agent finishes, inspect its session deterministically,
 * commit anything it left uncommitted, and bring back the summary it wrote.
 *
 * The agent's session is treated as hostile once the agent has run: it may
 * have planted git hooks, configuration or background processes. So no
 * credential ever enters it. The new commits leave the session as a git
 * bundle (pure data), and the push happens in a separate clean-room session
 * from a pristine clone, with hooks disabled and the token sent as a header.
 */
import type { WorkContext } from '../lib/context.ts';
import { commitIdentity, repositoryToken } from '../lib/github.ts';
import { cleanRoomTarget, mustRun, runCommand, sessionTarget } from '../lib/session.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitBranch,
  assertGitHubName,
  assertGitIdentity,
  gitAuthHeader,
  redactSecrets,
  shellQuote,
} from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

export interface CollectResult {
  pushed: boolean;
  commitCount: number;
  headSha: string;
  summary: string;
}

const SECTION = '\n===FACTORIAL-SECTION===\n';
/** Bundles beyond this are almost certainly a mistake (vendored dependencies, binaries). */
const MAX_BUNDLE_BYTES = 8_000_000;

export const LEFTOVER_COMMIT_MESSAGE = 'Apply remaining changes left by the agent';
export const SALVAGE_COMMIT_MESSAGE = 'Save work in progress after the build failed';

export function inspectScript(baseBranch: string, leftoverMessage: string = LEFTOVER_COMMIT_MESSAGE): string {
  return [
    'set -uo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    `if [ -n "$(git -c core.hooksPath=/dev/null status --porcelain=v1)" ]; then git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null -c user.name=Factorial -c user.email=agent@factorial.invalid commit --quiet -m ${shellQuote(leftoverMessage)}; fi`,
    `git rev-list --count ${shellQuote(`origin/${baseBranch}`)}..HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    'git rev-parse HEAD',
    `printf '%s' ${shellQuote(SECTION)}`,
    `git diff --name-only "$(git merge-base ${shellQuote(`origin/${baseBranch}`)} HEAD)" HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    'if [ -f /workspace/summary.md ]; then head -c 60000 /workspace/summary.md; fi',
  ].join('\n');
}

export interface Inspection {
  commitCount: number;
  headSha: string;
  /** Paths changed between the base branch and the agent's head. */
  changedPaths: string[];
  summary: string;
}

export function parseInspection(stdout: string): Inspection {
  const [count = '', sha = '', paths = '', summary = ''] = stdout.split(SECTION);
  const commitCount = Number.parseInt(count.trim(), 10);
  if (!Number.isInteger(commitCount) || !/^[0-9a-f]{40}$/.test(sha.trim())) {
    throw new Error(`Could not parse session inspection output: ${redactSecrets(stdout.slice(0, 500))}`);
  }
  const changedPaths = paths
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { commitCount, headSha: sha.trim(), changedPaths, summary: summary.trim() };
}

/** GitHub refuses pushes that touch Actions workflows unless the token carries the workflows permission. */
export function touchesWorkflows(changedPaths: string[]): boolean {
  return changedPaths.some((path) => path.startsWith('.github/workflows/'));
}

/** Export the new commits from the agent's session as a base64 bundle on stdout. */
export function bundleScript(baseBranch: string, headSha: string): string {
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    `test "$(git rev-parse HEAD)" = ${shellQuote(assertCommitSha(headSha, 'head sha'))}`,
    `git -c core.hooksPath=/dev/null bundle create /tmp/factorial.bundle ${shellQuote(`origin/${baseBranch}`)}..HEAD >/dev/null 2>&1`,
    `size=$(stat -c %s /tmp/factorial.bundle); if [ "$size" -gt ${MAX_BUNDLE_BYTES} ]; then echo "bundle too large: $size bytes" >&2; exit 3; fi`,
    'base64 -w0 /tmp/factorial.bundle',
  ].join('\n');
}

/**
 * Import the bundle into a pristine clone and push exactly the expected
 * commit to the work branch. Runs in the clean-room session.
 */
export function cleanRoomPushScript(params: {
  owner: string;
  name: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  token: string;
  bundleBase64: string;
  /** Author and committer for every pushed commit; the agent's own identity is discarded. */
  identity: { name: string; email: string };
}): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const headSha = assertCommitSha(params.headSha, 'head sha');
  const branch = assertGitBranch(params.branch, 'work branch');
  const baseBranch = assertGitBranch(params.baseBranch, 'base branch');
  const identity = assertGitIdentity(params.identity);
  const url = `https://github.com/${owner}/${name}.git`;
  const auth = shellQuote(gitAuthHeader(params.token));
  const ident = [
    `GIT_AUTHOR_NAME=${shellQuote(identity.name)}`,
    `GIT_AUTHOR_EMAIL=${shellQuote(identity.email)}`,
    `GIT_COMMITTER_NAME=${shellQuote(identity.name)}`,
    `GIT_COMMITTER_EMAIL=${shellQuote(identity.email)}`,
  ].join(' ');
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'rm -rf /workspace/push && mkdir -p /workspace/push && cd /workspace/push',
    `printf '%s' ${shellQuote(params.bundleBase64)} | base64 -d > incoming.bundle`,
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} clone --quiet --bare --filter=blob:none ${shellQuote(url)} repo.git`,
    'cd repo.git',
    // The clone is blob-less, so importing the bundle makes git fetch the
    // unchanged files' blobs from origin on demand; that lazy fetch needs
    // the same header or it fails asking for a username.
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} fetch --quiet ../incoming.bundle HEAD`,
    `test "$(git rev-parse FETCH_HEAD)" = ${shellQuote(headSha)}`,
    // Re-create the agent's commits with the App's identity: same trees,
    // messages and author dates, linear history only. The agent chose its
    // own author inside the sandbox; what GitHub attributes is decided here.
    `base=$(git merge-base ${shellQuote(`refs/heads/${baseBranch}`)} FETCH_HEAD)`,
    'test -z "$(git rev-list --merges "$base..FETCH_HEAD")"',
    'new=$base',
    'for c in $(git rev-list --reverse "$base..FETCH_HEAD"); do',
    `  new=$(git log -1 --format=%B "$c" | ${ident} GIT_AUTHOR_DATE="$(git log -1 --format=%aI "$c")" git commit-tree "$c^{tree}" -p "$new")`,
    'done',
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} push --quiet origin "$new:${`refs/heads/${branch}`}"`,
    'cd / && rm -rf /workspace/push',
    'echo "$new"',
  ].join('\n');
}

export interface CollectInput extends WorkContext {
  /**
   * Set when the build failed: push whatever the agent left so the work is
   * not lost. Uncommitted changes are committed with a message that says so.
   */
  salvage?: boolean;
}

export const handler = async (input: CollectInput): Promise<CollectResult> => {
  const { salvage = false, ...ctx } = input;
  const agentSession = sessionTarget(ctx.sessionId);
  const inspection = await runCommand(
    agentSession,
    inspectScript(ctx.baseBranch, salvage ? SALVAGE_COMMIT_MESSAGE : LEFTOVER_COMMIT_MESSAGE),
    300,
  );
  if (inspection.exitCode !== 0) {
    throw new Error(`Inspecting the session failed (${inspection.exitCode}): ${redactSecrets(inspection.stderr.slice(-2000))}`);
  }
  const { commitCount, headSha, changedPaths, summary } = parseInspection(inspection.stdout);

  if (commitCount === 0) {
    if (!salvage) await recordProgress(ctx.workItem.id, 'no-changes', { headSha, summary });
    console.log(JSON.stringify({ message: 'agent made no commits', workItemId: ctx.workItem.id }));
    return { pushed: false, commitCount, headSha, summary };
  }

  const bundle = await mustRun(agentSession, bundleScript(ctx.baseBranch, headSha), 300);
  const bundleBase64 = bundle.stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(bundleBase64)) {
    throw new Error('Bundle export did not produce base64 output');
  }

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const identity = await commitIdentity(repo);
  // Least privilege per push: the workflows permission is requested only
  // when the change edits a workflow file, so an ordinary change never
  // carries it.
  const editsWorkflows = touchesWorkflows(changedPaths);
  const token = await repositoryToken(repo, editsWorkflows ? { contents: 'write', workflows: 'write' } : { contents: 'write' }).catch(
    (error: unknown) => {
      if (editsWorkflows) {
        throw new Error(
          `The change edits GitHub Actions workflows, which needs the Factorial App's "Workflows: read and write" permission (docs/github-app.md): ${redactSecrets(String(error))}`,
        );
      }
      throw error;
    },
  );
  const push = await mustRun(
    cleanRoomTarget(ctx.workItem.id),
    cleanRoomPushScript({
      owner: repo.owner,
      name: repo.name,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
      headSha,
      token,
      bundleBase64,
      identity,
    }),
    600,
  );
  // The pushed head differs from the agent's: the commits were re-created
  // with the App's identity. Everything downstream tests and reviews this one.
  const pushedSha = assertCommitSha(push.stdout.trim().split('\n').pop() ?? '', 'pushed head');

  await recordProgress(ctx.workItem.id, salvage ? 'salvaged' : 'pushed', {
    headSha: pushedSha,
    agentHeadSha: headSha,
    commitCount,
    changedPaths: changedPaths.slice(0, 200),
    editsWorkflows,
    summary,
    bundleBytes: Math.floor((bundleBase64.length * 3) / 4),
  });
  console.log(
    JSON.stringify({
      message: salvage ? 'work in progress saved from clean room' : 'branch pushed from clean room',
      workItemId: ctx.workItem.id,
      branch: ctx.branch,
      headSha: pushedSha,
      agentHeadSha: headSha,
      commitCount,
    }),
  );
  return { pushed: true, commitCount, headSha: pushedSha, summary };
};
