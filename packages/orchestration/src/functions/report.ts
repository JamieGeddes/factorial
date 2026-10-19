/**
 * Report: close the loop with the requester when no pull request will follow,
 * whether because the agent made no changes, tests failed, or a step errored.
 */
import { artefactPrefix, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { assertWorkItem, type WorkItem } from '@factorial/workitem';

import { issueNumber, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { attemptRecord, recordProgress } from '../lib/table.ts';
import { testResultArtefact } from '../lib/test-result.ts';

interface ReportInput {
  status: 'no-changes' | 'tests-failed' | 'failed';
  /** Present once Prepare has run. */
  ctx?: WorkContext;
  /** The raw WorkItem, for failures before Prepare completed. */
  workItem?: unknown;
  summary?: string;
  error?: { Error?: string | undefined; Cause?: string };
  sessionIdHint?: string | undefined;
  /** What Collect pushed, if it ran: after a failed build, the saved work in progress. */
  saved?: { pushed?: boolean; commitCount?: number } | null;
}

/** A sentence pointing at the pushed branch, when there is one. */
export function savedWorkNote(input: Pick<ReportInput, 'ctx' | 'saved'>): string {
  if (!input.saved?.pushed || !input.ctx) return '';
  const { owner, name } = input.ctx.workItem.repository;
  const branch = input.ctx.branch;
  const url = `https://github.com/${owner}/${name}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const commits = input.saved.commitCount === 1 ? '1 commit' : `${input.saved.commitCount ?? 'the'} commits`;
  return ` Work in progress (${commits}) was saved to [\`${branch}\`](${url}); it is untested and no pull request was opened. Adding the label again resumes from that branch.`;
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
      return `Factorial could not complete this work item (\`${input.error?.Error ?? 'unknown error'}\`). Session \`${input.ctx?.sessionId ?? input.sessionIdHint ?? 'unknown'}\`; see the Factorial execution log.${savedWorkNote(input)}`;
  }
}

/** `report.json`: the outcome and a short reason. Causes are kept, redacted, for the reviewer. */
export function reportArtefact(input: Pick<ReportInput, 'status' | 'error' | 'saved'>): Record<string, unknown> {
  const reasons = {
    'no-changes': 'The agent made no changes.',
    'tests-failed': "The change did not pass the repository's checks.",
    failed: `A step failed: ${input.error?.Error ?? 'unknown error'}.`,
  };
  return {
    outcome: input.status,
    reason: reasons[input.status],
    ...(input.error ? { error: { Error: input.error.Error, Cause: input.error.Cause?.slice(0, 4000) } } : {}),
    ...(input.saved?.pushed ? { savedWork: true } : {}),
  };
}

/**
 * The attempt's prefix: from the context once Prepare has run, otherwise from
 * the ledger row if Prepare got that far, otherwise attempt 1.
 */
async function prefixFor(input: ReportInput, workItem: WorkItem): Promise<string> {
  if (input.ctx) return input.ctx.artefactPrefix;
  try {
    const record = await attemptRecord(workItem.id);
    if (record?.artefactPrefix) return record.artefactPrefix;
  } catch (error) {
    console.log(JSON.stringify({ message: 'no ledger row for artefacts', workItemId: workItem.id, error: String(error) }));
  }
  return artefactPrefix(workItem.id, 1);
}

/** Store the outcome, and for failed tests their result. Never stops the requester being told. */
async function storeArtefacts(input: ReportInput, workItem: WorkItem): Promise<void> {
  try {
    const prefix = await prefixFor(input, workItem);
    if (input.status === 'tests-failed') {
      await putJsonArtefact(prefix, 'test/result.json', testResultArtefact(safeJson(input.error?.Cause) ?? {}));
    }
    await putJsonArtefact(prefix, 'report.json', reportArtefact(input));
  } catch (error) {
    console.log(JSON.stringify({ message: 'artefacts not stored', workItemId: workItem.id, error: String(error) }));
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

  await recordProgress(workItem.id, input.status, { error, savedWork: input.saved?.pushed === true });
  await storeArtefacts({ ...input, ...(error ? { error } : {}) }, workItem);
  const issue = issueNumber(workItem);
  if (issue === undefined) return;

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const client = await repositoryClient(repo, { issues: 'write' });
  await client.commentOnIssue(repo, issue, message);
};
