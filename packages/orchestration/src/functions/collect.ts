/**
 * Collect: after the agent finishes, inspect the session deterministically,
 * commit anything it left uncommitted, push the branch with a write-scoped
 * token, and bring back the summary it wrote. The agent itself never pushes.
 */
import type { WorkContext } from '../lib/context.ts';
import { repositoryToken } from '../lib/github.ts';
import { mustRun, runCommand, sessionTarget } from '../lib/session.ts';
import { assertGitHubName, shellQuote } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

export interface CollectResult {
  pushed: boolean;
  commitCount: number;
  headSha: string;
  summary: string;
}

const SECTION = '\n===FACTORIAL-SECTION===\n';

export function inspectScript(baseBranch: string): string {
  return [
    'set -uo pipefail',
    'cd /workspace/repo',
    'if [ -n "$(git status --porcelain=v1)" ]; then git add -A && git -c user.name=Factorial -c user.email=factorial[bot]@users.noreply.github.com commit --quiet -m "Apply remaining changes left by the agent"; fi',
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
    throw new Error(`Could not parse session inspection output: ${stdout.slice(0, 500)}`);
  }
  return { commitCount, headSha: sha.trim(), summary: summary.trim() };
}

export function pushScript(params: { owner: string; name: string; branch: string; token: string }): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const url = `https://x-access-token:${params.token}@github.com/${owner}/${name}.git`;
  return [
    'set -euo pipefail',
    'cd /workspace/repo',
    `git push --quiet ${shellQuote(url)} ${shellQuote(`HEAD:refs/heads/${params.branch}`)}`,
  ].join('\n');
}

export const handler = async (ctx: WorkContext): Promise<CollectResult> => {
  const target = sessionTarget(ctx.sessionId);
  const inspection = await runCommand(target, inspectScript(ctx.baseBranch), 300);
  if (inspection.exitCode !== 0) {
    throw new Error(`Inspecting the session failed (${inspection.exitCode}): ${inspection.stderr.slice(-2000)}`);
  }
  const { commitCount, headSha, summary } = parseInspection(inspection.stdout);

  if (commitCount === 0) {
    await recordProgress(ctx.workItem.id, 'no-changes', { headSha, summary });
    console.log(JSON.stringify({ message: 'agent made no commits', workItemId: ctx.workItem.id }));
    return { pushed: false, commitCount, headSha, summary };
  }

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const token = await repositoryToken(repo, { contents: 'write' });
  await mustRun(target, pushScript({ owner: repo.owner, name: repo.name, branch: ctx.branch, token }), 300);

  await recordProgress(ctx.workItem.id, 'pushed', { headSha, commitCount, summary });
  console.log(JSON.stringify({ message: 'branch pushed', workItemId: ctx.workItem.id, branch: ctx.branch, headSha, commitCount }));
  return { pushed: true, commitCount, headSha, summary };
};
