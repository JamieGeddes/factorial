/**
 * Report: end a turn that opens or updates no pull request, whether because
 * the agent made no changes, tests failed, the plan was invalid, or a step
 * errored. It records the status on the ledger, writes `report.json` with
 * what delivery needs and emits the outcome (#165); the reporter for the
 * item's source type tells the requester. Report itself speaks to no one.
 */
import { artefactPrefix, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { assertWorkItem, type WorkItem } from '@factorial/workitem';

import type { WorkContext } from '../lib/context.ts';
import { builderIncomplete } from '../lib/incomplete.ts';
import { runKey, unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { emitOutcome, type OutcomeFacts } from '../lib/outcome.ts';
import { stageError, staged, stepError, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { REPORT_ARTEFACT, type ReportFacts, type ReportFile, type ReportStatus } from '../lib/report-file.ts';
import { attemptRecord, recordProgress, type AttemptRecord } from '../lib/table.ts';
import { testResultArtefact } from '../lib/test-result.ts';
import { continuedPullRequest } from '../lib/turn.ts';

export interface ReportInput extends ProgressInput {
  status: ReportStatus;
  /** Present once Prepare has run. */
  ctx?: WorkContext;
  /** The raw WorkItem, for failures before Prepare completed. */
  workItem?: unknown;
  summary?: string;
  error?: { Error?: string | undefined; Cause?: string };
  /** What Collect pushed, if it ran: after a failed build, the saved work in progress. */
  saved?: { pushed?: boolean; commitCount?: number; itemCommitCount?: number } | null;
  /** The build round that failed, when the build ran in rounds. */
  buildRound?: number | null;
}

function resolveWorkItem(input: Pick<ReportInput, 'ctx' | 'workItem'>): WorkItem | undefined {
  if (input.ctx) return input.ctx.workItem;
  try {
    assertWorkItem(input.workItem);
    return input.workItem;
  } catch {
    return undefined;
  }
}

/**
 * Whether the item reworks an open pull request. Its branch already backs
 * that pull request, so anything pushed is on the pull request at once.
 */
function isRework(input: Pick<ReportInput, 'ctx' | 'workItem'>): boolean {
  if (input.ctx) return input.ctx.rework !== undefined;
  const workItem = resolveWorkItem(input);
  return workItem !== undefined && continuedPullRequest(workItem) !== undefined;
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

/** The work pushed to the branch after a failed build, when Collect ran and pushed. */
function savedWork(input: Pick<ReportInput, 'ctx' | 'saved'>): { branch: string; commits?: number } | undefined {
  if (!input.saved?.pushed || !input.ctx) return undefined;
  const commits = input.saved.itemCommitCount;
  return { branch: input.ctx.branch, ...(commits ? { commits } : {}) };
}

/** What the requester is told, as facts: the reporter words them. Nothing from an error's cause beyond what is shown here. */
export function reportFacts(input: ReportInput, workItemId?: string): ReportFacts {
  const rework = isRework(input);
  const branch = input.ctx?.branch;
  const sessionId = input.ctx?.sessionId;
  const base = { status: input.status, rework, ...(branch ? { branch } : {}) };
  switch (input.status) {
    case 'no-changes':
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(input.summary?.trim() ? { agentSaid: input.summary } : {}) };
    case 'tests-failed': {
      const runUrl = safeJson(input.error?.Cause)?.runUrl;
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(typeof runUrl === 'string' ? { testRunUrl: runUrl } : {}) };
    }
    case 'invalid-plan': {
      const problems = invalidPlanProblems(input.error?.Cause);
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(problems.length > 0 ? { planProblems: problems } : {}) };
    }
    case 'failed': {
      const incomplete = builderIncomplete(input.error);
      // A step that failed before Prepare has no session; the work item id finds the run.
      const session = incomplete ? sessionId : (sessionId ?? workItemId);
      const saved = savedWork(input);
      const round = typeof input.buildRound === 'number' && Number.isInteger(input.buildRound) && input.buildRound > 0 ? input.buildRound : undefined;
      return {
        ...base,
        ...(session ? { sessionId: session } : {}),
        ...(incomplete ? { incomplete: true } : { errorName: input.error?.Error ?? 'unknown error' }),
        ...(incomplete && round !== undefined ? { buildRound: round } : {}),
        ...(saved ? { savedWork: saved } : {}),
      };
    }
  }
}

/** `report.json`: the outcome, a short reason, the redacted cause for the reviewer, and what delivery needs. */
export function reportArtefact(input: ReportInput, workItemId?: string): ReportFile {
  const reasons = {
    'no-changes': 'The agent made no changes.',
    'tests-failed': "The change did not pass the repository's checks.",
    failed: builderIncomplete(input.error) ? 'The builder reached its iteration or time limit before finishing.' : `A step failed: ${input.error?.Error ?? 'unknown error'}.`,
    'invalid-plan': 'The builder did not produce a valid plan.',
  };
  return {
    outcome: input.status,
    reason: reasons[input.status],
    ...(input.error ? { error: { Error: input.error.Error, Cause: input.error.Cause?.slice(0, 4000) } } : {}),
    ...(input.saved?.pushed ? { savedWork: true } : {}),
    delivery: { kind: 'report', facts: reportFacts(input, workItemId) },
  };
}

/** The ledger row's view of the attempt when Prepare did not finish; never fatal. */
async function recordFor(input: ReportInput, workItem: WorkItem, log: Logger): Promise<AttemptRecord | undefined> {
  if (input.ctx) return undefined;
  try {
    return await attemptRecord(workItem.id);
  } catch (error) {
    log.error('no ledger row for the attempt', { error });
    return undefined;
  }
}

/** The outcome's facts: from the context once Prepare has run, otherwise from what Intake recorded on the row. */
export function outcomeFacts(input: ReportInput, workItem: WorkItem, record: AttemptRecord | undefined): OutcomeFacts {
  const { ctx } = input;
  const attempt = ctx?.attempt ?? record?.attempt ?? 1;
  const saved = savedWork(input);
  const pr = ctx?.rework?.pullRequest ?? continuedPullRequest(workItem);
  return {
    workItem,
    attempt,
    artefactPrefix: ctx?.artefactPrefix ?? record?.artefactPrefix ?? artefactPrefix(workItem.id, attempt),
    result: input.status,
    threadKey: ctx?.threadKey ?? record?.threadKey,
    route: ctx ? 'change' : record?.route === 'change' ? 'change' : undefined,
    pullRequest: pr,
    branch: ctx?.branch ?? record?.branch,
    savedWork: saved,
  };
}

/** The run key from the context, or from the raw WorkItem when Prepare did not finish. */
function reportKey(input: ReportInput): RunKey {
  return input.ctx ? runKey(input.ctx) : { workItemId: unvalidatedId(input.workItem) };
}

/**
 * Every Report state ends the work item. Failed tests end the Test stage,
 * which only the workflow's result decides; any other stage still open ends
 * with the failure that brought the item here.
 */
const reportStage: StagePolicy<ReportInput, void> = {
  closes: (input) => (input.status === 'tests-failed' ? [{ stage: 'Test', outcome: 'failed', error: stepError(input.error) ?? stageError('TestsFailed') }] : []),
  ends: () => true,
  failure: (input) => stepError(input.error),
};

export const handler = staged('report', reportKey, reportStage, async (input: ReportInput, log): Promise<void> => {
  const workItem = resolveWorkItem(input);
  const error = input.error ? { Error: input.error.Error, Cause: redactSecrets(input.error.Cause ?? '').slice(0, 4000) } : undefined;
  log.info('reporting', { status: input.status, error });
  if (!workItem) return;
  await recordProgress(workItem.id, input.status, { error, savedWork: input.saved?.pushed === true });
  const facts = outcomeFacts(input, workItem, await recordFor(input, workItem, log));
  const redacted = { ...input, ...(error ? { error } : {}) };
  if (input.status === 'tests-failed') {
    try {
      await putJsonArtefact(facts.artefactPrefix, 'test/result.json', testResultArtefact(safeJson(error?.Cause) ?? {}));
    } catch (storeError) {
      log.error('test result not stored', { error: storeError });
    }
  }
  // The reporter reads report.json, so it is written before the outcome that points at it.
  await putJsonArtefact(facts.artefactPrefix, REPORT_ARTEFACT, reportArtefact(redacted, workItem.id));
  const outcome = await emitOutcome(facts);
  log.info('outcome emitted', { result: outcome.result });
});
