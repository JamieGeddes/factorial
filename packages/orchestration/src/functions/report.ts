/**
 * Report: close the loop with the requester when no pull request will follow,
 * whether because the agent made no changes, tests failed, or a step errored.
 */
import { assertWorkItem, type WorkItem } from '@factorial/workitem';

import { issueNumber, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { redactSecrets } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

interface ReportInput {
  status: 'no-changes' | 'tests-failed' | 'failed';
  /** Present once Prepare has run. */
  ctx?: WorkContext;
  /** The raw WorkItem, for failures before Prepare completed. */
  workItem?: unknown;
  summary?: string;
  error?: { Error?: string; Cause?: string };
  sessionIdHint?: string | undefined;
}

export function reportMessage(input: ReportInput): string {
  switch (input.status) {
    case 'no-changes':
      return [
        'Factorial ran but made no changes, so no pull request was opened.',
        input.summary?.trim() ? `\n**The agent said:**\n\n${input.summary.trim()}` : '',
      ].join('\n');
    case 'tests-failed': {
      const cause = safeJson(input.error?.Cause);
      const runUrl = typeof cause?.runUrl === 'string' ? cause.runUrl : undefined;
      return `Factorial's change did not pass the repository's checks${runUrl ? ` ([run](${runUrl}))` : ''}, so no pull request was opened. The branch \`${input.ctx?.branch ?? ''}\` is left for inspection.`;
    }
    case 'failed':
      // Deliberately generic: causes can contain command output. Details stay
      // in the execution history and the ledger, both inside the account.
      return `Factorial could not complete this work item (\`${input.error?.Error ?? 'unknown error'}\`). Session \`${input.ctx?.sessionId ?? input.sessionIdHint ?? 'unknown'}\`; see the Factorial execution log.`;
  }
}

function safeJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function resolveWorkItem(input: ReportInput): WorkItem | undefined {
  if (input.ctx) return input.ctx.workItem;
  try {
    assertWorkItem(input.workItem);
    return input.workItem;
  } catch {
    return undefined;
  }
}

export const handler = async (input: ReportInput): Promise<void> => {
  const workItem = resolveWorkItem(input);
  const message = reportMessage({ ...input, sessionIdHint: workItem?.id });
  const error = input.error
    ? { Error: input.error.Error, Cause: redactSecrets(input.error.Cause ?? '').slice(0, 4000) }
    : undefined;
  console.log(JSON.stringify({ message: 'reporting', status: input.status, workItemId: workItem?.id, error }));
  if (!workItem) return;

  await recordProgress(workItem.id, input.status, { error });
  const issue = issueNumber(workItem);
  if (issue === undefined) return;

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const client = await repositoryClient(repo, { issues: 'write' });
  await client.commentOnIssue(repo, issue, message);
};
