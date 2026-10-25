/**
 * Report: close the loop with the requester when no pull request will follow,
 * whether because the agent made no changes, tests failed, or a step errored.
 */
import { artefactPrefix, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { assertWorkItem, type WorkItem } from '@factorial/workitem';

import { issueNumber, type WorkContext } from '../lib/context.ts';
import { builderIncomplete } from '../lib/incomplete.ts';
import { repositoryClient } from '../lib/github.ts';
import { logged, runKey, unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { attemptRecord, recordProgress } from '../lib/table.ts';
import { testResultArtefact } from '../lib/test-result.ts';

interface ReportInput {
  status: 'no-changes' | 'tests-failed' | 'failed' | 'invalid-plan';
  /** Present once Prepare has run. */
  ctx?: WorkContext;
  /** The raw WorkItem, for failures before Prepare completed. */
  workItem?: unknown;
  summary?: string;
  error?: { Error?: string | undefined; Cause?: string };
  sessionIdHint?: string | undefined;
  /** What Collect pushed, if it ran: after a failed build, the saved work in progress. */
  saved?: { pushed?: boolean; commitCount?: number } | null;
  /** The build round that failed, when the build ran in rounds. */
  buildRound?: number | null;
}

/** A sentence pointing at the pushed branch, when there is one. */
export function savedWorkNote(input: Pick<ReportInput, 'ctx' | 'saved'>): string {
  if (!input.saved?.pushed || !input.ctx) return '';
  const { owner, name } = input.ctx.workItem.repository;
  const branch = input.ctx.branch;
  const url = `https://github.com/${owner}/${name}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  // A later round with no new commits keeps the earlier rounds' head, so its
  // own count of 0 says nothing about what the branch holds.
  const count = input.saved.commitCount;
  const commits = count === 1 ? ' (1 commit)' : count ? ` (${count} commits)` : '';
  return ` Work in progress${commits} was saved to [\`${branch}\`](${url}); it is untested and no pull request was opened. Adding the label again resumes from that branch.`;
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
    case 'invalid-plan': {
      // The problems are the validator's messages about the planner's
      // files, redacted with the cause, and useful to whoever relabels.
      const problems = invalidPlanProblems(input.error?.Cause);
      return [
        `Factorial's planner did not produce a valid plan after two attempts, so nothing was built. Session \`${input.ctx?.sessionId ?? 'unknown'}\`.`,
        ...(problems.length > 0 ? ['', '**Problems with the last plan:**', '', ...problems.map((p) => `- ${p}`)] : []),
      ].join('\n');
    }
    case 'failed':
      if (builderIncomplete(input.error)) {
        const rounds = typeof input.buildRound === 'number' && input.buildRound > 1 ? ` in ${input.buildRound} sessions` : '';
        return `Factorial's builder reached its iteration or time limit${rounds} before finishing, so the change was not tested and no pull request was opened. Session \`${input.ctx?.sessionId ?? 'unknown'}\`.${savedWorkNote(input)}`;
      }
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
    failed: builderIncomplete(input.error)
      ? 'The builder reached its iteration or time limit before finishing.'
      : `A step failed: ${input.error?.Error ?? 'unknown error'}.`,
    'invalid-plan': 'The planner did not produce a valid plan after two attempts.',
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
async function prefixFor(input: ReportInput, workItem: WorkItem, log: Logger): Promise<string> {
  if (input.ctx) return input.ctx.artefactPrefix;
  try {
    const record = await attemptRecord(workItem.id);
    if (record?.artefactPrefix) return record.artefactPrefix;
  } catch (error) {
    log.error('no ledger row for artefacts', { error });
  }
  return artefactPrefix(workItem.id, 1);
}

/** Store the outcome, and for failed tests their result. Never stops the requester being told. */
async function storeArtefacts(input: ReportInput, workItem: WorkItem, log: Logger): Promise<void> {
  try {
    const prefix = await prefixFor(input, workItem, log);
    if (input.status === 'tests-failed') {
      await putJsonArtefact(prefix, 'test/result.json', testResultArtefact(safeJson(input.error?.Cause) ?? {}));
    }
    await putJsonArtefact(prefix, 'report.json', reportArtefact(input));
  } catch (error) {
    log.error('artefacts not stored', { error });
  }
}

/**
 * The listed problems from an InvalidPlan error's cause (a Lambda error
 * object as JSON), for a public comment. They can quote what the planner
 * wrote (property names, a JSON snippet), so each is redacted, cut short,
 * kept to one line and shown as inline code, which GitHub renders
 * literally: no mentions, links or formatting. A JSON syntax error keeps
 * only its first clause, without the snippet.
 */
export function invalidPlanProblems(cause: string | undefined): string[] {
  const message = safeJson(cause)?.errorMessage;
  if (typeof message !== 'string') return [];
  return message
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const problem = line.slice(2).replace(/(is not valid JSON).*$/, '$1');
      const flat = redactSecrets(problem).replace(/[`\r\n\t]/g, ' ').slice(0, 200);
      return `\`${flat}\``;
    })
    .slice(0, 10);
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

/** The run key from the context, or from the raw WorkItem when Prepare did not finish. */
function reportKey(input: ReportInput): RunKey {
  return input.ctx ? runKey(input.ctx) : { workItemId: unvalidatedId(input.workItem) };
}

export const handler = logged('report', reportKey, async (input: ReportInput, log): Promise<void> => {
  const workItem = resolveWorkItem(input);
  const message = reportMessage({ ...input, sessionIdHint: workItem?.id });
  const error = input.error
    ? { Error: input.error.Error, Cause: redactSecrets(input.error.Cause ?? '').slice(0, 4000) }
    : undefined;
  log.info('reporting', { status: input.status, error });
  if (!workItem) return;

  await recordProgress(workItem.id, input.status, { error, savedWork: input.saved?.pushed === true });
  await storeArtefacts({ ...input, ...(error ? { error } : {}) }, workItem, log);
  const issue = issueNumber(workItem);
  if (issue === undefined) return;

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const client = await repositoryClient(repo, { issues: 'write' });
  await client.commentOnIssue(repo, issue, message);
});
