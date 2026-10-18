/**
 * Prepare: accept the WorkItem exactly once, then set up the agent's session
 * deterministically: clone the repository, create the work branch, and leave
 * the WorkItem on disk for the agent to read. No model is involved.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The read-only token is sent as an HTTP header for the clone only and is not
 * written anywhere in the session.
 */
import { assertWorkItem } from '@factorial/workitem';

import { branchFor, type WorkContext } from '../lib/context.ts';
import { repositoryToken } from '../lib/github.ts';
import { mustRun, sessionTarget } from '../lib/session.ts';
import { HARDENED_GIT_ENV, assertGitHubName, assertUuid, gitAuthHeader, shellQuote } from '../lib/shell.ts';
import { acceptWorkItem, recordProgress } from '../lib/table.ts';

interface PrepareInput {
  workItem: unknown;
  factorialVersion: string;
}

export function cloneScript(params: { owner: string; name: string; branch: string; token: string; workItemJson: string }): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const url = `https://github.com/${owner}/${name}.git`;
  const workItemBase64 = Buffer.from(params.workItemJson, 'utf8').toString('base64');
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'rm -rf /workspace/repo /workspace/summary.md /workspace/workitem.json /workspace/notes.md',
    `git -c http.extraHeader=${shellQuote(gitAuthHeader(params.token))} clone --quiet ${shellQuote(url)} /workspace/repo`,
    'cd /workspace/repo',
    `git checkout --quiet -b ${shellQuote(params.branch)}`,
    `printf '%s' ${shellQuote(workItemBase64)} | base64 -d > /workspace/workitem.json`,
    `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'`,
  ].join('\n');
}

export const handler = async (input: PrepareInput): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  await acceptWorkItem(workItem, input.factorialVersion);

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const branch = branchFor(workItem);
  const token = await repositoryToken(repo, { contents: 'read' });
  const target = sessionTarget(workItem.id);

  const result = await mustRun(
    target,
    cloneScript({ owner: repo.owner, name: repo.name, branch, token, workItemJson: JSON.stringify(workItem, null, 2) }),
    600,
  );
  const baseBranch = result.stdout.trim().split('\n').pop() ?? 'main';

  await recordProgress(workItem.id, 'prepared', { branch, baseBranch, sessionId: workItem.id });
  console.log(JSON.stringify({ message: 'session prepared', workItemId: workItem.id, branch, baseBranch }));

  return { workItem, sessionId: workItem.id, branch, baseBranch, factorialVersion: input.factorialVersion };
};
