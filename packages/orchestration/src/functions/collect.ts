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
import { repositoryToken } from '../lib/github.ts';
import { cleanRoomTarget, mustRun, runCommand, sessionTarget } from '../lib/session.ts';
import { HARDENED_GIT_ENV, assertCommitSha, assertGitHubName, gitAuthHeader, redactSecrets, shellQuote } from '../lib/shell.ts';
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

export function inspectScript(baseBranch: string): string {
  return [
    'set -uo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    'if [ -n "$(git -c core.hooksPath=/dev/null status --porcelain=v1)" ]; then git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null -c user.name=Factorial -c user.email=factorial[bot]@users.noreply.github.com commit --quiet -m "Apply remaining changes left by the agent"; fi',
    `git rev-list --count ${shellQuote(`origin/${baseBranch}`)}..HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    'git rev-parse HEAD',
    `printf '%s' ${shellQuote(SECTION)}`,
    'if [ -f /workspace/summary.md ]; then head -c 60000 /workspace/summary.md; fi',
  ].join('\n');
}

export function parseInspection(stdout: string): { commitCount: number; headSha: string; summary: string } {
  const [count = '', sha = '', summary = ''] = stdout.split(SECTION);
  const commitCount = Number.parseInt(count.trim(), 10);
  if (!Number.isInteger(commitCount) || !/^[0-9a-f]{40}$/.test(sha.trim())) {
    throw new Error(`Could not parse session inspection output: ${redactSecrets(stdout.slice(0, 500))}`);
  }
  return { commitCount, headSha: sha.trim(), summary: summary.trim() };
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
  headSha: string;
  token: string;
  bundleBase64: string;
}): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const headSha = assertCommitSha(params.headSha, 'head sha');
  const url = `https://github.com/${owner}/${name}.git`;
  const auth = shellQuote(gitAuthHeader(params.token));
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
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} push --quiet origin ${shellQuote(`${headSha}:refs/heads/${params.branch}`)}`,
    'cd / && rm -rf /workspace/push',
  ].join('\n');
}

export const handler = async (ctx: WorkContext): Promise<CollectResult> => {
  const agentSession = sessionTarget(ctx.sessionId);
  const inspection = await runCommand(agentSession, inspectScript(ctx.baseBranch), 300);
  if (inspection.exitCode !== 0) {
    throw new Error(`Inspecting the session failed (${inspection.exitCode}): ${redactSecrets(inspection.stderr.slice(-2000))}`);
  }
  const { commitCount, headSha, summary } = parseInspection(inspection.stdout);

  if (commitCount === 0) {
    await recordProgress(ctx.workItem.id, 'no-changes', { headSha, summary });
    console.log(JSON.stringify({ message: 'agent made no commits', workItemId: ctx.workItem.id }));
    return { pushed: false, commitCount, headSha, summary };
  }

  const bundle = await mustRun(agentSession, bundleScript(ctx.baseBranch, headSha), 300);
  const bundleBase64 = bundle.stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(bundleBase64)) {
    throw new Error('Bundle export did not produce base64 output');
  }

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const token = await repositoryToken(repo, { contents: 'write' });
  await mustRun(
    cleanRoomTarget(ctx.workItem.id),
    cleanRoomPushScript({ owner: repo.owner, name: repo.name, branch: ctx.branch, headSha, token, bundleBase64 }),
    600,
  );

  await recordProgress(ctx.workItem.id, 'pushed', { headSha, commitCount, summary, bundleBytes: Math.floor((bundleBase64.length * 3) / 4) });
  console.log(JSON.stringify({ message: 'branch pushed from clean room', workItemId: ctx.workItem.id, branch: ctx.branch, headSha, commitCount }));
  return { pushed: true, commitCount, headSha, summary };
};
