/**
 * Intake: accept the WorkItem exactly once, resolve the thread it is a turn
 * in, and choose its route (#163, `docs/design-extension-points.md` §3.2).
 * The adapter only records what happened; what it means is decided here,
 * with the pull request as GitHub reports it and the thread's record.
 *
 * - A new request opens a thread for a new branch. A request whose earlier
 *   attempt stopped with its work saved resumes that attempt's thread.
 * - A turn on a pull request finds the thread of the pull request. A pull
 *   request opened before threads existed has its thread created from the
 *   ledger's record of it.
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
import { assertWorkItem, type WorkItem, type WorkItemReworkCause } from '@factorial/workitem';

import { branchFor, type ReworkTurn } from '../lib/context.ts';
import { botLogin, repositoryClient } from '../lib/github.ts';
import { assertIntakeRecord, type IntakeRecord, type RefusalStatus } from '../lib/intake-record.ts';
import { logged, unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { nextAttempt, resumableAttempt, sourceKey, type Attempt } from '../lib/resume.ts';
import { commentToAcknowledge, inlineCommentIdFromUrl } from '../lib/rework-points.ts';
import { assertGitBranch, assertUuid } from '../lib/shell.ts';
import {
  REFUSED_STATUSES,
  admitTurn,
  pullRequestMismatch,
  stateFromHistory,
  type Admission,
  type EarlierItem,
} from '../lib/thread-policy.ts';
import { ThreadChangedError, announceLimit, getThread, openThread, threadForPullRequest, threadKeyFor, writeThreadState, type Thread } from '../lib/thread.ts';
import {
  TooManyItemsError,
  acceptWorkItem,
  attemptRecord,
  attemptsAtSource,
  itemsAtSourceKey,
  legacyPullRequestSourceKey,
  openerOf,
  pullRequestKey,
  recordProgress,
  reworkCauseOf,
  sourceKeyOf,
  statusOf,
} from '../lib/table.ts';
import { claimedBranch, continuedPullRequest, reworkCause } from '../lib/turn.ts';

interface IntakeInput {
  workItem: unknown;
  factorialVersion: string;
}

/** What the state machine carries from Intake: the route, and for `change` what Prepare needs. */
export type IntakeResult =
  | {
      route: 'change';
      attempt: number;
      artefactPrefix: string;
      threadKey: string;
      branch: string;
      resumedFrom?: Attempt;
      rework?: ReworkTurn;
    }
  | { route: 'refuse'; attempt: number; artefactPrefix: string; status: RefusalStatus; reason: string };

/** A decision before it is recorded: the route, and what the record and the reply need. */
export type Decision =
  | {
      route: 'change';
      turn: 'new' | 'resume' | 'rework';
      reason: string;
      thread: Thread;
      resumedFrom?: Attempt;
      rework?: ReworkTurn;
    }
  | {
      route: 'refuse';
      turn: 'new' | 'resume' | 'rework';
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
 * exists. Any failure to tell (a lookup error, a deleted branch) starts the
 * item afresh. Read before the item is accepted, so its row is written with
 * its attempt number.
 */
async function resumable(repo: Repo, workItem: WorkItem, log: Logger): Promise<Attempt | undefined> {
  try {
    const attempt = resumableAttempt(await attemptsAtSource(workItem), workItem.id);
    if (!attempt?.branch) return undefined;
    const branch = assertGitBranch(attempt.branch, 'resume branch');
    if (!branch.startsWith('factorial/')) return undefined;
    const client = await repositoryClient(repo, { contents: 'read' });
    await client.getBranchSha(repo, branch);
    const record = await attemptRecord(attempt.workItemId);
    return { ...attempt, branch, ...(record?.attempt === undefined ? {} : { attempt: record.attempt }) };
  } catch (error) {
    log.info('not resuming', { error });
    return undefined;
  }
}

/** A new request, or a new attempt at one: the thread of the branch it works on, opened if new. */
async function requestTurn(repo: Repo, workItem: WorkItem, resumedFrom: Attempt | undefined): Promise<Decision> {
  const branch = resumedFrom?.branch ?? branchFor(workItem);
  const turn = resumedFrom ? 'resume' : 'new';
  const thread = await openThread({
    threadKey: threadKeyFor(repo, branch),
    owner: repo.owner,
    name: repo.name,
    branch,
    // A resumed branch from before threads gets its thread now; the attempt
    // it resumes is the earliest turn known.
    openedBy: resumedFrom?.workItemId ?? workItem.id,
    sourceKey: sourceKey(workItem),
  });
  const admission = await claimThread(workItem.id, undefined, thread);
  if (!admission.ok) return { route: 'refuse', turn, status: admission.status, reason: admission.reason, thread };
  return {
    route: 'change',
    turn,
    reason: resumedFrom ? `Resumes work item ${resumedFrom.workItemId}, which stopped with its work saved.` : 'A new request.',
    thread,
    ...(resumedFrom ? { resumedFrom } : {}),
  };
}

/**
 * The thread of a pull request opened before threads existed, created from
 * the ledger: the item that opened it, its branch, and the history of rework
 * items recorded under the pull request's legacy source key, from which the
 * count of automatic reworks is carried over.
 */
async function threadFromLedger(repo: Repo, number: number): Promise<Thread | undefined> {
  const opener = await openerOf(repo, number);
  if (!opener?.branch) return undefined;
  const branch = assertGitBranch(opener.branch, 'pull request branch');
  const history: EarlierItem[] = await itemsAtSourceKey(legacyPullRequestSourceKey(repo, number));
  for (const item of history) {
    if (REFUSED_STATUSES.has(item.status ?? '')) continue;
    const cause = await reworkCauseOf(item.workItemId);
    if (cause !== undefined) item.cause = cause;
    if (cause !== 'checks-failed') break;
  }
  return openThread({
    threadKey: threadKeyFor(repo, branch),
    owner: repo.owner,
    name: repo.name,
    branch,
    openedBy: opener.workItemId,
    sourceKey: (await sourceKeyOf(opener.workItemId)) ?? '',
    pullRequestKey: pullRequestKey(repo, number),
    prNumber: number,
    prOpenedBy: opener.workItemId,
    ...stateFromHistory(history),
  });
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

  let thread: Thread | undefined;
  try {
    thread = (await threadForPullRequest(pullRequestKey(repo, pr.number))) ?? (await threadFromLedger(repo, pr.number));
  } catch (error) {
    if (error instanceof TooManyItemsError) return refuse('busy', error.message);
    throw error;
  }
  if (!thread?.prOpenedBy) return refuse('not-eligible', `Factorial has no record of opening pull request #${pr.number}`);
  const claimed = claimedBranch(workItem);
  if (claimed !== undefined && claimed !== thread.branch) {
    return refuse('not-eligible', `the item that opened pull request #${pr.number} worked on ${thread.branch}, not ${claimed}`, { thread });
  }

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

/** The intake record for a decision, validated before anything acts on it. */
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
  if (decision.route === 'change') {
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

/** Answer a refusal on the pull request when a person asked. Never fatal: the refusal is recorded either way. */
async function reply(repo: Repo, number: number, text: string, log: Logger): Promise<boolean> {
  try {
    const client = await repositoryClient(repo, { issues: 'write', pull_requests: 'write' });
    await client.commentOnIssue(repo, number, text);
    return true;
  } catch (error) {
    log.error('refusal not posted on the pull request', { error });
    return false;
  }
}

const intakeKey = (input: IntakeInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

export const handler = logged('intake', intakeKey, async (input, stageLog): Promise<IntakeResult> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const pr = continuedPullRequest(workItem);
  const resumedFrom = pr ? undefined : await resumable(repo, workItem, stageLog);
  const attempt = nextAttempt(resumedFrom);
  const log = stageLog.with({ attempt });
  const prefix = artefactPrefix(workItem.id, attempt);

  await acceptWorkItem(workItem, input.factorialVersion, attempt);
  await putJsonArtefact(prefix, 'workitem.json', workItem);

  const decision = pr ? await pullRequestTurn(repo, workItem, pr) : await requestTurn(repo, workItem, resumedFrom);
  const threadKey = decision.thread?.threadKey;

  if (decision.route === 'refuse') {
    const replied = decision.reply !== undefined && decision.prNumber !== undefined ? await reply(repo, decision.prNumber, decision.reply, log) : false;
    const record = intakeRecord(workItem.id, decision, replied);
    await recordProgress(workItem.id, decision.status, {
      route: 'refuse',
      threadKey,
      refusedReason: decision.reason,
      ...(decision.prNumber !== undefined ? { reworkOf: { previousWorkItemId: record.previousWorkItemId, prNumber: decision.prNumber } } : {}),
    });
    await putJsonArtefact(prefix, 'intake/intake.json', record);
    await putJsonArtefact(prefix, 'report.json', { outcome: decision.status, reason: decision.reason });
    log.info('refused', { status: decision.status, reason: decision.reason, threadKey, replied });
    return { route: 'refuse', attempt, artefactPrefix: prefix, status: decision.status, reason: decision.reason };
  }

  const record = intakeRecord(workItem.id, decision);
  await recordProgress(workItem.id, 'accepted', { route: 'change', threadKey, branch: decision.thread.branch });
  await putJsonArtefact(prefix, 'intake/intake.json', record);
  if (decision.rework) await acknowledge(repo, workItem, log);
  log.info('admitted', { route: 'change', turn: decision.turn, threadKey });
  return {
    route: 'change',
    attempt,
    artefactPrefix: prefix,
    threadKey: decision.thread.threadKey,
    branch: decision.thread.branch,
    ...(decision.resumedFrom ? { resumedFrom: decision.resumedFrom } : {}),
    ...(decision.rework ? { rework: decision.rework } : {}),
  };
});
