/**
 * Report: end a turn that opens or updates no pull request, whether because
 * a plan was proposed for approval (#169), the agent made no changes, a
 * required verifier did not pass, the plan was invalid, or a step errored. It records the status on the ledger, writes `report.json` with
 * what delivery needs and emits the outcome (#165); the reporter for the
 * item's source type tells the requester. Report itself speaks to no one.
 */
import { artefactPrefix, getTextArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { assertWorkItem, type WorkItem } from '@factorial/workitem';

import type { WorkContext } from '../lib/context.ts';
import { builderIncomplete } from '../lib/incomplete.ts';
import { runKey, unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { emitOutcome, type OutcomeFacts } from '../lib/outcome.ts';
import { stageError, staged, stepError, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { REPORT_ARTEFACT, type ProposalFacts, type ReportFacts, type ReportFile, type ReportStatus } from '../lib/report-file.ts';
import { MAX_PLAN_ARTEFACT_BYTES } from '../lib/review-files.ts';
import { PROPOSED_STEPS_CHARS, ProposalHiddenTextError, ProposalTooLargeError, hasHiddenCharacters, planSha256, proposedSteps } from '../lib/proposal-view.ts';
import { parsePlanJson } from '@factorial/plan';
import { attemptRecord, recordProgress, type AttemptRecord } from '../lib/table.ts';
import { continuedPullRequest } from '../lib/turn.ts';
import { failedVerifierOf, verifyProblemsOf } from '../lib/verify.ts';
import { REFUSED_PATHS_SHOWN, workflowPathsOf, workflowPathsOmitted } from '../lib/workflow-changes.ts';

/** `proposed` ends a propose turn with its plan; the rest end a turn that failed or found nothing to do. */
export type ReportInputStatus = ReportStatus | 'proposed';

export interface ReportInput extends ProgressInput {
  status: ReportInputStatus;
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

/** The error the state machine raises for an invalid `.factorial/verifiers.json` on the base branch. */
export const VERIFY_UNCONFIGURED = 'VerifyUnconfigured';

/** A problem as a public comment shows it: redacted, one line, cut short, as inline code, which GitHub renders literally. */
function codeSpan(problem: string): string {
  return `\`${redactSecrets(problem).replace(/[`\r\n\t]/g, ' ').slice(0, 200)}\``;
}

/** The work pushed to the branch after a failed build, when Collect ran and pushed. */
function savedWork(input: Pick<ReportInput, 'ctx' | 'saved'>): { branch: string; commits?: number } | undefined {
  if (!input.saved?.pushed || !input.ctx) return undefined;
  const commits = input.saved.itemCommitCount;
  return { branch: input.ctx.branch, ...(commits ? { commits } : {}) };
}

/** What the requester is told, as facts: the reporter words them. Nothing from an error's cause beyond what is shown here. */
export function reportFacts(input: ReportInput & { status: ReportStatus }, workItemId?: string): ReportFacts {
  const rework = isRework(input);
  const branch = input.ctx?.branch;
  const sessionId = input.ctx?.sessionId;
  const base = { status: input.status, rework, ...(branch ? { branch } : {}) };
  switch (input.status) {
    case 'no-changes':
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(input.summary?.trim() ? { agentSaid: input.summary } : {}) };
    case 'tests-failed': {
      const failed = failedVerifierOf(input.error?.Cause);
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(failed ? { failedVerifier: failed } : {}) };
    }
    case 'invalid-plan': {
      const problems = invalidPlanProblems(input.error?.Cause);
      return { ...base, ...(sessionId ? { sessionId } : {}), ...(problems.length > 0 ? { planProblems: problems } : {}) };
    }
    case 'workflow-change-refused': {
      const paths = workflowPathsOf(input.error?.Cause);
      const more = paths.length - REFUSED_PATHS_SHOWN + workflowPathsOmitted(input.error?.Cause);
      return {
        ...base,
        ...(sessionId ? { sessionId } : {}),
        ...(paths.length > 0 ? { workflowPaths: paths.slice(0, REFUSED_PATHS_SHOWN).map(codeSpan) } : {}),
        ...(more > 0 ? { workflowPathsMore: more } : {}),
      };
    }
    case 'failed': {
      const incomplete = builderIncomplete(input.error);
      // A step that failed before Prepare has no session; the work item id finds the run.
      const session = incomplete ? sessionId : (sessionId ?? workItemId);
      const saved = savedWork(input);
      const round = typeof input.buildRound === 'number' && Number.isInteger(input.buildRound) && input.buildRound > 0 ? input.buildRound : undefined;
      const problems = input.error?.Error === VERIFY_UNCONFIGURED ? verifyProblemsOf(input.error.Cause).map(codeSpan) : [];
      return {
        ...base,
        ...(session ? { sessionId: session } : {}),
        ...(incomplete ? { incomplete: true } : { errorName: input.error?.Error ?? 'unknown error' }),
        ...(problems.length > 0 ? { verifyProblems: problems } : {}),
        ...(incomplete && round !== undefined ? { buildRound: round } : {}),
        ...(saved ? { savedWork: saved } : {}),
      };
    }
  }
}

/** A proposal's plan as Collect stored it: plan.json, which the build follows, and plan.md. */
export interface ProposedPlan {
  json: string;
  markdown: string;
}

/**
 * The proposal's facts: plan.json's steps rendered whole, the hash an
 * approval is bound to, plan.md as context, and where the approval will
 * build. A plan whose steps do not fit in a comment is not proposed
 * (ProposalTooLarge): an approver must be able to read all of what is built.
 */
export function proposalFacts(input: Pick<ReportInput, 'ctx'>, plan: ProposedPlan): ProposalFacts {
  if (!input.ctx) throw new Error('a proposal is reported only after Prepare');
  const parsed = parsePlanJson(plan.json);
  if (!parsed.ok) throw new Error(`the proposed plan.json is not a valid plan: ${parsed.errors.slice(0, 3).join('; ')}`);
  if (hasHiddenCharacters(parsed.value)) throw new ProposalHiddenTextError();
  const steps = proposedSteps(parsed.value);
  if (steps.length > PROPOSED_STEPS_CHARS) throw new ProposalTooLargeError(steps.length);
  return { steps, planSha256: planSha256(plan.json), plan: plan.markdown, branch: input.ctx.branch, sessionId: input.ctx.sessionId };
}

/** `report.json`: the outcome, a short reason, the redacted cause for the reviewer, and what delivery needs. `plan` is the proposal's stored plan, for `proposed`. */
export function reportArtefact(input: ReportInput, workItemId?: string, plan?: ProposedPlan): ReportFile {
  if (input.status === 'proposed') {
    if (plan === undefined) throw new Error('a proposal is reported with its plan');
    return { outcome: 'proposed', reason: 'The builder proposed a plan for approval and changed nothing.', delivery: { kind: 'proposal', proposal: proposalFacts(input, plan) } };
  }
  const status = input.status;
  const reasons = {
    'no-changes': 'The agent made no changes.',
    'tests-failed': "The change did not pass the repository's checks.",
    failed: builderIncomplete(input.error)
      ? 'The builder reached its iteration or time limit before finishing.'
      : input.error?.Error === VERIFY_UNCONFIGURED
        ? "The base branch's .factorial/verifiers.json is not valid, so the change could not be verified."
        : `A step failed: ${input.error?.Error ?? 'unknown error'}.`,
    'invalid-plan': 'The builder did not produce a valid plan.',
    'workflow-change-refused': 'The change edits GitHub Actions workflows or actions and the target has not opted in.',
  };
  return {
    outcome: status,
    reason: reasons[status],
    ...(input.error ? { error: { Error: input.error.Error, Cause: input.error.Cause?.slice(0, 4000) } } : {}),
    ...(input.saved?.pushed ? { savedWork: true } : {}),
    delivery: { kind: 'report', facts: reportFacts({ ...input, status }, workItemId) },
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
    route: ctx ? (ctx.route ?? 'change') : record?.route === 'change' || record?.route === 'propose' ? record.route : undefined,
    pullRequest: pr,
    branch: ctx?.branch ?? record?.branch,
    savedWork: saved,
  };
}

/** The proposed plan, which Collect stored before it ended the turn `proposed`, read back as stored: its hash binds the approval. */
async function proposedPlan(input: ReportInput): Promise<ProposedPlan> {
  if (!input.ctx) throw new Error('a proposal is reported only after Prepare');
  const prefix = input.ctx.artefactPrefix;
  const [json, markdown] = await Promise.all([
    getTextArtefact(prefix, 'plan/plan.json', MAX_PLAN_ARTEFACT_BYTES),
    getTextArtefact(prefix, 'plan/plan.md', MAX_PLAN_ARTEFACT_BYTES),
  ]);
  if (json === undefined || markdown === undefined || json.truncated) throw new Error(`the proposed plan is not whole under ${prefix}plan/`);
  return { json: json.text, markdown: markdown.text };
}

/** The run key from the context, or from the raw WorkItem when Prepare did not finish. */
function reportKey(input: ReportInput): RunKey {
  return input.ctx ? runKey(input.ctx) : { workItemId: unvalidatedId(input.workItem) };
}

/**
 * Every Report state ends the work item. A failed verifier ends the Verify
 * stage, which CollectVerifier has usually ended already; any other stage
 * still open ends with the failure that brought the item here.
 */
const reportStage: StagePolicy<ReportInput, void> = {
  closes: (input) => (input.status === 'tests-failed' ? [{ stage: 'Verify', outcome: 'failed', error: stepError(input.error) ?? stageError('VerifierFailed') }] : []),
  ends: () => true,
  failure: (input) => stepError(input.error),
};

export const handler = staged('report', reportKey, reportStage, async (input: ReportInput, log): Promise<void> => {
  const workItem = resolveWorkItem(input);
  const error = input.error ? { Error: input.error.Error, Cause: redactSecrets(input.error.Cause ?? '').slice(0, 4000) } : undefined;
  log.info('reporting', { status: input.status, error });
  if (!workItem) return;
  // A proposal's plan is read and checked before the turn is recorded proposed: one that cannot be shown whole fails the turn instead.
  const plan = input.status === 'proposed' ? await proposedPlan(input) : undefined;
  const redacted = { ...input, ...(error ? { error } : {}) };
  const report = plan ? reportArtefact(redacted, workItem.id, plan) : undefined;
  const bound = report?.delivery?.kind === 'proposal' ? { planSha256: report.delivery.proposal.planSha256 } : {};
  await recordProgress(workItem.id, input.status, { error, savedWork: input.saved?.pushed === true, ...bound });
  const facts = outcomeFacts(input, workItem, await recordFor(input, workItem, log));
  // The reporter reads report.json, so it is written before the outcome that points at it.
  await putJsonArtefact(facts.artefactPrefix, REPORT_ARTEFACT, report ?? reportArtefact(redacted, workItem.id));
  const outcome = await emitOutcome(facts);
  log.info('outcome emitted', { result: outcome.result });
});
