/**
 * Intake: accept the WorkItem exactly once, resolve the thread it is a turn
 * in, and choose its route (#163, `docs/design-extension-points.md` §3.2).
 * The adapter only records what happened; what it means is decided here,
 * with the pull request as GitHub reports it and the thread's record.
 *
 * - A new request opens a thread for a new branch. A request whose earlier
 *   attempt stopped with its work saved resumes that attempt's thread.
 * - An issue labelled for a plan (`github-issue-plan`) is a new request on
 *   the `propose` route: the builder plans and changes nothing (#169).
 * - An issue labelled for work whose newest turn proposed a plan approves
 *   it: the `change` route on the proposal's thread, from its stored plan.
 * - A comment in an issue's conversation (`inReplyTo` the issue) is read
 *   by what it says: `plan this` proposes, `approve` approves the proposal
 *   and `revise: …` proposes again from it, on its thread. Anything else is
 *   refused with a reply that says what is understood.
 * - A turn on a pull request finds the thread of the pull request.
 * - An item in the superseded rework `context` shape is refused: nothing
 *   emits it since #163, and nothing downstream reads it.
 * - The thread policies (`lib/thread-policy.ts`) admit or refuse the turn,
 *   and an admission claims the thread with one conditional write.
 *
 * The route goes on the ledger row and in `intake/intake.json`, and the
 * state machine's Route choice acts on it. No model is involved and no
 * session is touched. The read-only token used here never leaves this
 * function.
 */
import { artefactPrefix, putJsonArtefact } from '@factorial/artefacts';
import type { Repo } from '@factorial/github-app';
import { TRIGGER_TYPES, assertWorkItem, type WorkItem, type WorkItemReworkCause } from '@factorial/workitem';

import { branchFor, type Proposal, type ReworkTurn } from '../lib/context.ts';
import { botLogin, repositoryClient } from '../lib/github.ts';
import { assertIntakeRecord, type IntakeRecord, type RefusalStatus } from '../lib/intake-record.ts';
import { unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { emitOutcome } from '../lib/outcome.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { issueRequest, storeIssueRequest } from '../lib/issue-request.ts';
import { REPORT_ARTEFACT, type ReportFile } from '../lib/report-file.ts';
import type { SeedRequest } from '../lib/seed.ts';
import { nextAttempt, resumableAttempt, sourceKey, type Attempt } from '../lib/resume.ts';
import { commentToAcknowledge, inlineCommentIdFromUrl } from '../lib/rework-points.ts';
import { assertGitBranch, assertUuid } from '../lib/shell.ts';
import { admitTurn, pullRequestMismatch, type Admission } from '../lib/thread-policy.ts';
import {
  ThreadChangedError,
  announceLimit,
  getThread,
  newestThreadForSource,
  openThread,
  threadForPullRequest,
  threadKeyFor,
  writeThreadState,
  type Thread,
} from '../lib/thread.ts';
import { acceptWorkItem, attemptRecord, pullRequestKey, recordProgress, statusOf, turnsOf, type Turn } from '../lib/table.ts';
import { continuedIssue, continuedPullRequest, issueCommand, issueCommandHelp, reworkCause } from '../lib/turn.ts';

interface IntakeInput extends ProgressInput {
  workItem: unknown;
  factorialVersion: string;
  /** The execution's ARN; its name is EventBridge's, not the work item id (#203). Absent from an execution started before #203. */
  executionArn?: string;
}

/** What the state machine carries from Intake: the route, and for `change` or `propose` what Prepare needs. */
export type IntakeResult =
  | {
      route: 'change' | 'propose';
      attempt: number;
      artefactPrefix: string;
      threadKey: string;
      branch: string;
      resumedFrom?: Attempt;
      rework?: ReworkTurn;
      approves?: Proposal;
      /** For a revise turn, the proposal whose plan the new proposal starts from. */
      revises?: Proposal;
    }
  | { route: 'refuse'; attempt: number; artefactPrefix: string; status: RefusalStatus; reason: string };

/** A decision before it is recorded: the route, and what the record and the reply need. */
export type Decision =
  | {
      route: 'change' | 'propose';
      turn: 'new' | 'resume' | 'rework' | 'approve' | 'revise';
      reason: string;
      thread: Thread;
      resumedFrom?: Attempt;
      rework?: ReworkTurn;
      approves?: Proposal;
      revises?: Proposal;
      /** For a turn asked for in an issue's conversation: the issue as read now, stored as the turn's request. */
      request?: SeedRequest;
    }
  | {
      route: 'refuse';
      turn: 'new' | 'resume' | 'rework' | 'approve' | 'revise';
      status: RefusalStatus;
      reason: string;
      reply?: string;
      thread?: Thread;
      prNumber?: number;
      cause?: WorkItemReworkCause;
    };

/** How often a turn re-reads its thread after another turn wrote it first. */
const CLAIM_ATTEMPTS = 3;

/**
 * Apply the thread policies and claim the thread, re-reading it if another
 * turn changed it first. A refusal that announces the limit is recorded on
 * the thread too, so it is said once.
 */
async function claimThread(workItemId: string, cause: WorkItemReworkCause | undefined, first: Thread): Promise<Admission> {
  let thread: Thread | undefined = first;
  for (let i = 0; i < CLAIM_ATTEMPTS; i += 1) {
    if (i > 0) thread = await getThread(first.threadKey);
    if (!thread) throw new Error(`thread ${first.threadKey} disappeared`);
    const holder = thread.inFlight?.workItemId;
    const holderStatus = holder !== undefined && holder !== workItemId ? await statusOf(holder) : undefined;
    const admission = admitTurn({ workItemId, ...(cause ? { cause } : {}) }, thread, holderStatus, new Date());
    try {
      if (admission.ok) await writeThreadState(thread, admission.claim);
      else if (admission.announces) await announceLimit(thread);
      return admission;
    } catch (error) {
      if (!(error instanceof ThreadChangedError)) throw error;
    }
  }
  throw new ThreadChangedError(first.threadKey);
}

/**
 * The earlier attempt to resume, if any, and only while its branch still
 * exists: a turn by the same source on the newest thread the source opened.
 * Any failure to tell (a lookup error, a deleted branch) starts the item
 * afresh. Read before the item is accepted, so its row is written with its
 * attempt number.
 */
async function resumable(repo: Repo, workItem: WorkItem, log: Logger): Promise<Attempt | undefined> {
  try {
    const source = sourceKey(workItem);
    const thread = await newestThreadForSource(source);
    if (!thread) return undefined;
    const branch = assertGitBranch(thread.branch, 'resume branch');
    if (!branch.startsWith('factorial/')) return undefined;
    // Only the source's own attempts count: a turn on the thread's pull
    // request is not an attempt at the request.
    const turns = (await turnsOf(thread.threadKey)).filter((turn) => turn.sourceKey === source);
    const attempts: Attempt[] = await Promise.all(
      turns.map(async (turn) => {
        const record = await attemptRecord(turn.workItemId);
        return {
          workItemId: turn.workItemId,
          branch,
          ...(turn.status === undefined ? {} : { status: turn.status }),
          ...(record?.savedWork === undefined ? {} : { savedWork: record.savedWork }),
          ...(record?.attempt === undefined ? {} : { attempt: record.attempt }),
        };
      }),
    );
    const attempt = resumableAttempt(attempts, workItem.id);
    if (!attempt) return undefined;
    const client = await repositoryClient(repo, { contents: 'read' });
    await client.getBranchSha(repo, branch);
    return attempt;
  } catch (error) {
    log.info('not resuming', { error });
    return undefined;
  }
}

/** Statuses of a turn Intake refused: it ran nothing, so it says nothing about what the thread last did. */
const REFUSED_STATUSES: ReadonlySet<string> = new Set(['not-eligible', 'busy', 'rework-limit', 'covered-by-review']);

/**
 * The turn a request for work approves, given a thread's turns newest first:
 * the newest turn that ran, other than the request itself, when it ended
 * `proposed`. A turn that ran since (an earlier approval, say) means there is
 * nothing left to approve.
 */
export function proposalToApprove(turns: readonly Turn[], currentId: string): Turn | undefined {
  const latest = turns.find((turn) => turn.workItemId !== currentId && !REFUSED_STATUSES.has(turn.status ?? ''));
  return latest?.status === 'proposed' ? latest : undefined;
}

/**
 * The proposal a request for work approves, if any: the newest turn that ran
 * on the newest thread the issue opened ended `proposed` on the `propose`
 * route. Any failure to tell starts the item as it would have started
 * without one. Read before the item is accepted, like `resumable`.
 */
async function approvable(workItem: WorkItem, log: Logger): Promise<{ thread: Thread; proposal: Proposal } | undefined> {
  try {
    const thread = await newestThreadForSource(sourceKey(workItem));
    if (!thread) return undefined;
    const latest = proposalToApprove(await turnsOf(thread.threadKey), workItem.id);
    if (!latest) return undefined;
    const record = await attemptRecord(latest.workItemId);
    if (record?.route !== 'propose' || record.artefactPrefix === undefined || !/^[0-9a-f]{64}$/.test(record.planSha256 ?? '')) return undefined;
    return { thread, proposal: { workItemId: latest.workItemId, artefactPrefix: record.artefactPrefix, planSha256: record.planSha256 as string } };
  } catch (error) {
    log.info('not approving a proposal', { error });
    return undefined;
  }
}

/** The approval of a proposed plan: a change on the proposal's thread and branch, built from its stored plan. */
async function approveTurn(workItem: WorkItem, found: { thread: Thread; proposal: Proposal }): Promise<Decision> {
  const { thread, proposal } = found;
  const admission = await claimThread(workItem.id, undefined, thread);
  if (!admission.ok) return { route: 'refuse', turn: 'approve', status: admission.status, reason: admission.reason, thread };
  return {
    route: 'change',
    turn: 'approve',
    reason: `Approves the plan proposed by work item ${proposal.workItemId}.`,
    thread,
    approves: proposal,
  };
}

/**
 * A comment in an issue's conversation (#169). The issue must be open and an
 * issue, read from GitHub; then what was said decides the turn. A person
 * asked, so every refusal carries a reply, posted on the issue by the
 * reporter.
 */
async function issueTurn(repo: Repo, workItem: WorkItem, issue: { number: number; url: string }, log: Logger): Promise<Decision> {
  const slug = (await botLogin()).replace(/\[bot\]$/, '');
  const refuse = (reason: string, reply: string, extra: { status?: RefusalStatus; turn?: Decision['turn']; thread?: Thread } = {}): Decision => ({
    route: 'refuse',
    turn: extra.turn ?? 'new',
    status: extra.status ?? 'not-eligible',
    reason,
    reply,
    ...(extra.thread ? { thread: extra.thread } : {}),
  });

  const client = await repositoryClient(repo, { issues: 'read' });
  const state = await client.getIssue(repo, issue.number);
  if (state.isPullRequest) return refuse(`#${issue.number} is a pull request, not an issue`, `#${issue.number} is a pull request: ask for changes there as a review or a comment.`);
  if (state.state !== 'open') return refuse(`issue #${issue.number} is ${state.state}`, `This issue is ${state.state}, so Factorial has not acted on it. Reopen it to ask again.`);

  // The request as it is now, which every session for the turn is seeded from.
  const request = issueRequest(state, issue.url);
  const command = issueCommand(workItem.body);
  switch (command.kind) {
    case 'plan': {
      const decision = await requestTurn(repo, workItem, undefined, 'propose');
      return decision.route === 'refuse' ? decision : { ...decision, request };
    }
    case 'approve': {
      const found = await approvable(workItem, log);
      if (!found) return refuse('no proposed plan to approve', `There is no proposed plan on this issue to approve.\n\n${issueCommandHelp(slug)}`, { turn: 'approve' });
      const decision = await approveTurn(workItem, found);
      return decision.route === 'refuse' ? { ...decision, reply: 'Factorial is already working on this issue, so the approval was not started. Ask again once it has replied.' } : { ...decision, request };
    }
    case 'revise': {
      const found = await approvable(workItem, log);
      if (!found) return refuse('no proposed plan to revise', `There is no proposed plan on this issue to revise.\n\n${issueCommandHelp(slug)}`, { turn: 'revise' });
      const admission = await claimThread(workItem.id, undefined, found.thread);
      if (!admission.ok) {
        return refuse(admission.reason, `Factorial is already working on this issue, so the revision was not started. Ask again once it has replied.`, { status: admission.status, turn: 'revise', thread: found.thread });
      }
      return {
        route: 'propose',
        turn: 'revise',
        reason: `Revises the plan proposed by work item ${found.proposal.workItemId}, as asked in a comment on issue #${issue.number}.`,
        thread: found.thread,
        revises: found.proposal,
        request,
      };
    }
    case 'unknown':
      return refuse('the comment asks for nothing Factorial understands on an issue', issueCommandHelp(slug));
  }
}

/** A new request, or a new attempt at one: the thread of the branch it works on, opened if new. A request for a plan takes the `propose` route. */
async function requestTurn(repo: Repo, workItem: WorkItem, resumedFrom: Attempt | undefined, route: 'change' | 'propose' = 'change'): Promise<Decision> {
  const branch = resumedFrom?.branch ?? branchFor(workItem);
  const turn = resumedFrom ? 'resume' : 'new';
  // A resumed attempt's thread exists; this returns it as it is.
  const thread = await openThread({
    threadKey: threadKeyFor(repo, branch),
    owner: repo.owner,
    name: repo.name,
    branch,
    openedBy: workItem.id,
    sourceKey: sourceKey(workItem),
  });
  const admission = await claimThread(workItem.id, undefined, thread);
  if (!admission.ok) return { route: 'refuse', turn, status: admission.status, reason: admission.reason, thread };
  const reason = resumedFrom
    ? `Resumes work item ${resumedFrom.workItemId}, which stopped with its work saved.`
    : route === 'propose'
      ? 'A request for a plan to approve.'
      : 'A new request.';
  return {
    route,
    turn,
    reason,
    thread,
    ...(resumedFrom ? { resumedFrom } : {}),
  };
}

/**
 * A turn on a pull request: Factorial must have opened it from a thread it
 * knows, it must still be open on that branch, and the thread policies must
 * admit the turn. The cause is derived from what happened.
 */
async function pullRequestTurn(repo: Repo, workItem: WorkItem, pr: { number: number; url: string }): Promise<Decision> {
  const cause = reworkCause(workItem);
  const refuse = (status: RefusalStatus, reason: string, extra: { reply?: string; thread?: Thread } = {}): Decision => ({
    route: 'refuse',
    turn: 'rework',
    status,
    reason,
    prNumber: pr.number,
    ...(cause ? { cause } : {}),
    ...extra,
  });
  if (cause === undefined) return refuse('not-eligible', `Factorial does not know what a ${workItem.source.type} on a pull request asks for`);

  const thread = await threadForPullRequest(pullRequestKey(repo, pr.number));
  if (!thread?.prOpenedBy) return refuse('not-eligible', `Factorial has no record of opening pull request #${pr.number}`);

  const client = await repositoryClient(repo, { pull_requests: 'read' });
  const state = await client.getPullRequest(repo, pr.number);
  const mismatch = pullRequestMismatch(state, thread.branch, await botLogin());
  if (mismatch) return refuse('not-eligible', mismatch, { thread });

  // An inline comment addressed to Factorial inside a review that requests
  // changes also arrives as that review, whose item takes all its comments.
  // Whichever item came first, only the review's may run.
  const commentId = cause === 'review' ? inlineCommentIdFromUrl(workItem.source.url) : undefined;
  if (commentId !== undefined && (await client.reviewStateOfComment(repo, pr.number, commentId)) === 'CHANGES_REQUESTED') {
    return refuse('covered-by-review', 'the comment belongs to a review requesting changes, which is reworked as a whole', { thread });
  }

  const admission = await claimThread(workItem.id, cause, thread);
  if (!admission.ok) return refuse(admission.status, admission.reason, { thread, ...(admission.reply ? { reply: admission.reply } : {}) });
  const why = { review: 'A review', 'checks-failed': 'Failed checks', comment: 'A request in the conversation' }[cause];
  return {
    route: 'change',
    turn: 'rework',
    reason: `${why} on pull request #${pr.number}, which Factorial opened.`,
    thread,
    rework: { pullRequest: pr, cause, previousWorkItemId: thread.prOpenedBy, baseBranch: state.baseRef },
  };
}

/** The intake record for a decision, validated before anything acts on it. `replied`: a reply on the pull request is due, which the reporter posts. */
export function intakeRecord(workItemId: string, decision: Decision, replied = false): IntakeRecord {
  const thread = decision.thread;
  const record: IntakeRecord = {
    schemaVersion: 1,
    workItemId,
    route: decision.route,
    turn: decision.turn,
    reason: decision.reason.slice(0, 1000),
    ...(thread ? { threadKey: thread.threadKey, branch: thread.branch } : {}),
  };
  if (decision.route !== 'refuse') {
    if (decision.approves) record.approves = decision.approves.workItemId;
    if (decision.revises) record.revises = decision.revises.workItemId;
    if (decision.rework) {
      record.pullRequest = decision.rework.pullRequest.number;
      record.cause = decision.rework.cause;
      record.previousWorkItemId = decision.rework.previousWorkItemId;
    }
    if (decision.resumedFrom) record.resumedFrom = decision.resumedFrom.workItemId;
  } else {
    if (decision.prNumber !== undefined) record.pullRequest = decision.prNumber;
    if (decision.cause) record.cause = decision.cause;
    if (thread?.prOpenedBy) record.previousWorkItemId = thread.prOpenedBy;
    record.refusal = { status: decision.status, replied };
  }
  assertIntakeRecord(record);
  return record;
}

/**
 * React to the comment that asked for the work (eyes), so the person sees
 * at once that it was taken; the reply comes when the rework finishes. A
 * review has no reaction API, and a failed run no comment. Never fatal.
 */
async function acknowledge(repo: Repo, workItem: WorkItem, log: Logger): Promise<void> {
  const target = commentToAcknowledge(workItem.source.url);
  if (!target) return;
  try {
    const client = await repositoryClient(repo, { issues: 'write', pull_requests: 'write' });
    await client.addReaction(repo, target, 'eyes');
  } catch (error) {
    log.error('comment not acknowledged', { error });
  }
}

const intakeKey = (input: IntakeInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

/** Intake's stage starts once the ledger row exists; a refusal ends the work item here. */
const intakeStage: StagePolicy<IntakeInput, IntakeResult> = { startsInHandler: true, ends: (_input, result) => result?.route === 'refuse' };

export const handler = staged('intake', intakeKey, intakeStage, async (input, stageLog, stage): Promise<IntakeResult> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const pr = continuedPullRequest(workItem);
  const issue = continuedIssue(workItem);
  const superseded = workItem.context !== undefined;
  // A request for a plan always starts afresh; a request for work first looks for a proposal to approve, then for an attempt to resume. A comment on an issue says what it wants (issueTurn).
  const forPlan = workItem.source.type === TRIGGER_TYPES.githubIssuePlan;
  const proposal = pr || issue || superseded || forPlan ? undefined : await approvable(workItem, stageLog);
  const resumedFrom = pr || issue || superseded || forPlan || proposal ? undefined : await resumable(repo, workItem, stageLog);
  const attempt = nextAttempt(resumedFrom);
  const log = stageLog.with({ attempt });
  const prefix = artefactPrefix(workItem.id, attempt);

  await acceptWorkItem(workItem, input.factorialVersion, attempt, input.executionArn);
  await stage.start();
  await putJsonArtefact(prefix, 'workitem.json', workItem);

  const decision: Decision = superseded
    ? { route: 'refuse', turn: 'rework', status: 'not-eligible', reason: 'the rework context is superseded by inReplyTo (#163); the item names no pull request Intake reads' }
    : pr
      ? await pullRequestTurn(repo, workItem, pr)
      : issue
        ? await issueTurn(repo, workItem, issue, log)
        : proposal
        ? await approveTurn(workItem, proposal)
        : await requestTurn(repo, workItem, resumedFrom, forPlan ? 'propose' : 'change');
  const threadKey = decision.thread?.threadKey;

  if (decision.route === 'refuse') {
    // A person who asked is answered where they asked, on the pull request or the issue, by the reporter.
    const reply = decision.reply !== undefined && (decision.prNumber !== undefined || issue !== undefined) ? decision.reply : undefined;
    const record = intakeRecord(workItem.id, decision, reply !== undefined);
    await recordProgress(workItem.id, decision.status, {
      route: 'refuse',
      threadKey,
      refusedReason: decision.reason,
      ...(decision.prNumber !== undefined ? { reworkOf: { previousWorkItemId: record.previousWorkItemId, prNumber: decision.prNumber } } : {}),
    });
    await putJsonArtefact(prefix, 'intake/intake.json', record);
    await putJsonArtefact(prefix, REPORT_ARTEFACT, {
      outcome: decision.status,
      reason: decision.reason,
      delivery: { kind: 'refusal', ...(reply !== undefined ? { reply } : {}) },
    } satisfies ReportFile);
    try {
      await emitOutcome({
        workItem,
        attempt,
        artefactPrefix: prefix,
        result: 'refused',
        reason: decision.status,
        route: 'refuse',
        threadKey,
        pullRequest: decision.prNumber !== undefined ? pr : undefined,
        branch: decision.thread?.branch,
      });
    } catch (error) {
      // The refusal is recorded either way; only the reply is lost.
      log.error('outcome not emitted', { error });
    }
    log.info('refused', { status: decision.status, reason: decision.reason, threadKey, replyDue: reply !== undefined });
    return { route: 'refuse', attempt, artefactPrefix: prefix, status: decision.status, reason: decision.reason };
  }

  const record = intakeRecord(workItem.id, decision);
  // The route and the approval go on the row, where the invoker reads them for the builder's first message.
  await recordProgress(workItem.id, 'accepted', {
    route: decision.route,
    threadKey,
    branch: decision.thread.branch,
    ...(decision.approves ? { approves: decision.approves.workItemId } : {}),
    ...(decision.revises ? { revises: decision.revises.workItemId } : {}),
  });
  // Stored before the intake record, which says the turn was admitted: a turn on an issue is never seeded without its request.
  if (decision.request) await storeIssueRequest(prefix, decision.request);
  await putJsonArtefact(prefix, 'intake/intake.json', record);
  if (decision.rework || issue) await acknowledge(repo, workItem, log);
  log.info('admitted', { route: decision.route, turn: decision.turn, threadKey, ...(decision.approves ? { approves: decision.approves.workItemId } : {}) });
  return {
    route: decision.route,
    attempt,
    artefactPrefix: prefix,
    threadKey: decision.thread.threadKey,
    branch: decision.thread.branch,
    ...(decision.resumedFrom ? { resumedFrom: decision.resumedFrom } : {}),
    ...(decision.rework ? { rework: decision.rework } : {}),
    ...(decision.approves ? { approves: decision.approves } : {}),
    ...(decision.revises ? { revises: decision.revises } : {}),
  };
});
