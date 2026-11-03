/**
 * The Work items view's rows, built from ledger and thread rows on the
 * server and sent to the browser as they are: only what the table shows.
 */
import { isRepository, issueUrl, pullRequestUrl, type Repository } from './links.ts';
import { buildRounds, currentStage, isStale, resultOf, statusPill, RESULT_SINCE, type Pill } from './status.ts';
import { oneLine, text } from './sanitise.ts';
import type { LedgerRow, ThreadRow } from './records.ts';
import { isVerifyStage } from './stages.ts';

export const FILTERS = ['all', 'running', 'waiting', 'finished', 'attention', 'refused'] as const;
export type Filter = (typeof FILTERS)[number];

export const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  running: 'Running',
  waiting: 'Waiting',
  finished: 'Finished',
  attention: 'Needs attention',
  refused: 'Refused',
};

/** One source type: how the views name it and its reference. */
export interface SourceType {
  label: string;
  /**
   * The reference shown and, when the app can build one from validated
   * fields, its link (`lib/links.ts`). The recorded `source.url` is never used.
   */
  reference(row: LedgerRow, repo?: Repository): { ref: string; url?: string };
}

const sourceId = (row: LedgerRow): string => oneLine(text(row.workItem?.source?.id)).slice(0, 40);

const issue: SourceType['reference'] = (row, repo) => {
  const url = repo ? issueUrl(repo, Number(row.workItem?.source?.id)) : undefined;
  return { ref: `#${sourceId(row)}`, ...(url ? { url } : {}) };
};

/** The issue a comment in its conversation was made on (#169), or the source id when none is recorded. */
const issueConversation: SourceType['reference'] = (row, repo) => {
  const number = row.workItem?.inReplyTo?.number;
  if (typeof number !== 'number') return { ref: sourceId(row) };
  const url = repo ? issueUrl(repo, number) : undefined;
  return { ref: `#${number}`, ...(url ? { url } : {}) };
};

/** The pull request a rework replies to, or the source id when none is recorded. */
const pullRequest: SourceType['reference'] = (row, repo) => {
  const item = row.workItem ?? {};
  const pr = item.inReplyTo?.number ?? row.reworkOf?.prNumber ?? item.context?.pullRequest?.number;
  if (typeof pr !== 'number') return { ref: sourceId(row) };
  const url = repo ? pullRequestUrl(repo, pr) : undefined;
  return { ref: `PR #${pr}`, ...(url ? { url } : {}) };
};

/** Every source type the views know. A new trigger type adds one entry, with its URL builder in `lib/links.ts`. */
export const SOURCES: Readonly<Record<string, SourceType>> = {
  'github-issue': { label: 'GitHub issue', reference: issue },
  'github-issue-plan': { label: 'Plan for issue', reference: issue },
  'github-issue-comment': { label: 'Issue comment', reference: issueConversation },
  'github-pull-request': { label: 'Pull request', reference: pullRequest },
  'github-pull-request-review': { label: 'PR review', reference: pullRequest },
  'github-pull-request-review-comment': { label: 'PR review comment', reference: pullRequest },
  'github-pull-request-comment': { label: 'PR comment', reference: pullRequest },
  'github-workflow-run': { label: 'Checks failed', reference: pullRequest },
};

/** An unknown type: its raw type as the label, the source id as text, no link. */
function sourceType(type: string): SourceType {
  return Object.hasOwn(SOURCES, type) ? (SOURCES[type] as SourceType) : { label: type, reference: (row) => ({ ref: sourceId(row) }) };
}

export function sourceLabel(type: string): string {
  return sourceType(type).label;
}

export interface WorkItemSummary {
  id: string;
  title: string;
  source: { type: string; label: string; ref: string; url?: string };
  requester: string;
  repository?: Repository;
  branch?: string;
  /** From the ledger row's `prNumber`, or its thread's; `state` only when the thread records this pull request. */
  pullRequest?: { number: number; url?: string; state?: PullRequestState };
  status: Pill;
  /** Running and not in Test. */
  running: boolean;
  /** Running in Test: no agent in session, waiting on GitHub Actions. */
  waiting: boolean;
  /** Running with a live record more than a minute old. */
  stale: boolean;
  result?: string;
  stage?: string;
  rounds: number;
  attempt: number;
  createdAt?: string;
  endedAt?: string;
  costUsd?: number;
  review?: { verdict: string; mean?: number };
  /** The run the row opens: the latest agent run. */
  latestRun?: { stage: string; round: number };
  /** The row has no `workItem`: a stage update wrote it for an id that was never accepted. */
  incomplete?: true;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

/** What the thread says of pull request `number`: merged or closed once recorded, open until then; nothing when it records another. */
function pullRequestState(thread: ThreadRow | undefined, number: number): PullRequestState | undefined {
  if (thread?.prNumber !== number) return undefined;
  const state = thread.outcome?.state;
  return state === 'merged' || state === 'closed' ? state : 'open';
}

export const INCOMPLETE_TITLE = 'No WorkItem recorded';
export const INCOMPLETE_NOTE = 'Written by a stage update; no WorkItem was accepted';

const RUN_FOLDERS: Record<string, string> = { Build: 'build', Review: 'review' };

/** What the item cost: its runs' estimates, and the live run's while it has no record yet. */
export function costOf(row: LedgerRow): number | undefined {
  let total = 0;
  let any = false;
  const recorded = new Set<string>();
  for (const [key, entry] of Object.entries(row.stages ?? {})) {
    const cost = entry?.run?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      total += cost;
      any = true;
      recorded.add(key);
    }
  }
  const live = row.live;
  if (live && !live.ended && typeof live.costUsd === 'number' && live.stage) {
    const stage = live.stage === 'build' ? 'Build' : live.stage === 'review' ? 'Review' : undefined;
    const key = stage && live.round && live.round > 1 ? `${stage}#${live.round}` : stage;
    if (key && !recorded.has(key)) {
      total += live.costUsd;
      any = true;
    }
  }
  return any ? Math.round(total * 10_000) / 10_000 : undefined;
}

function latestRun(row: LedgerRow): { stage: string; round: number } | undefined {
  let latest: { stage: string; round: number; at: string } | undefined;
  for (const [key, entry] of Object.entries(row.stages ?? {})) {
    const [stage = key, r] = key.split('#');
    const folder = RUN_FOLDERS[stage];
    if (!folder || !entry?.startedAt) continue;
    if (!latest || entry.startedAt > latest.at) latest = { stage: folder, round: r ? Number(r) : 1, at: entry.startedAt };
  }
  if (latest) return { stage: latest.stage, round: latest.round };
  const live = row.live;
  if (live?.stage && /^[a-z]+$/.test(live.stage)) return { stage: live.stage, round: live.round ?? 1 };
  return undefined;
}

function meanOf(scores: Record<string, number> | undefined): number | undefined {
  const values = Object.values(scores ?? {}).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export function summarise(row: LedgerRow, thread?: ThreadRow, now = Date.now(), resultSince = RESULT_SINCE): WorkItemSummary {
  const incomplete = !row.workItem;
  const item = row.workItem ?? {};
  const result = resultOf(row, resultSince);
  const current = currentStage(row);
  const repository = isRepository(item.repository) ? { owner: item.repository.owner, name: item.repository.name } : undefined;
  const type = incomplete ? '' : text(item.source?.type) || 'unknown';
  const { ref, url } = incomplete ? { ref: '', url: undefined } : sourceType(type).reference(row, repository);
  const prNumber = typeof row.prNumber === 'number' ? row.prNumber : thread?.prNumber;
  const prUrl = repository && prNumber ? pullRequestUrl(repository, prNumber) : undefined;
  const prState = prNumber ? pullRequestState(thread, prNumber) : undefined;
  const pill = statusPill(row, thread, resultSince);
  const status = incomplete ? { ...pill, note: INCOMPLETE_NOTE } : pill;
  const running = result === undefined && !isVerifyStage(current?.stage);
  const waiting = result === undefined && isVerifyStage(current?.stage);
  const cost = costOf(row);
  const mean = meanOf(row.reviewScores);
  const run = latestRun(row);
  const endedAt = result === undefined ? undefined : (row.endedAt ?? row.updatedAt);
  return {
    id: row.workItemId,
    title: incomplete ? INCOMPLETE_TITLE : oneLine(text(item.title)) || '(no title)',
    source: { type, label: type ? sourceLabel(type) : '', ref, ...(url ? { url } : {}) },
    requester: oneLine(text(item.requestedBy)),
    ...(repository ? { repository } : {}),
    ...(row.branch ? { branch: oneLine(row.branch) } : {}),
    ...(prNumber ? { pullRequest: { number: prNumber, ...(prUrl ? { url: prUrl } : {}), ...(prState ? { state: prState } : {}) } } : {}),
    status,
    running,
    waiting,
    stale: isStale(row, now, resultSince),
    ...(result !== undefined ? { result } : {}),
    ...(result === 'refused' ? { stage: 'Intake' } : current ? { stage: current.stage } : {}),
    rounds: buildRounds(row),
    attempt: typeof row.attempt === 'number' ? row.attempt : 1,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(row.reviewVerdict ? { review: { verdict: oneLine(row.reviewVerdict), ...(mean !== undefined ? { mean } : {}) } } : {}),
    ...(run ? { latestRun: run } : {}),
    ...(incomplete ? { incomplete: true as const } : {}),
  };
}

const FINISHED = new Set(['pr-opened', 'pr-updated', 'proposed', 'no-changes']);
const ATTENTION = new Set(['failed', 'tests-failed', 'invalid-plan']);

export function matchesFilter(item: WorkItemSummary, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'running':
      return item.running;
    case 'waiting':
      return item.waiting;
    case 'finished':
      return item.result !== undefined && FINISHED.has(item.result);
    case 'attention':
      return (item.result !== undefined && ATTENTION.has(item.result)) || item.stale;
    case 'refused':
      return item.result === 'refused';
  }
}

/** Search over id, title, branch and pull request. */
export function matchesSearch(item: WorkItemSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const pr = item.pullRequest ? `#${item.pullRequest.number} pr #${item.pullRequest.number}` : '';
  return [item.id, item.title, item.branch ?? '', pr, item.source.ref].some((field) => field.toLowerCase().includes(q));
}

/** Running and waiting items first, then newest first. */
export function compareItems(a: WorkItemSummary, b: WorkItemSummary): number {
  const rank = (i: WorkItemSummary) => (i.running || i.waiting ? 0 : 1);
  return rank(a) - rank(b) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

/** Newest created first, with no special place for running items; items with no creation time last. */
export function newestFirst(a: WorkItemSummary, b: WorkItemSummary): number {
  if (!a.createdAt || !b.createdAt) return a.createdAt ? -1 : b.createdAt ? 1 : 0;
  return b.createdAt.localeCompare(a.createdAt);
}

export function isFilter(value: unknown): value is Filter {
  return typeof value === 'string' && (FILTERS as readonly string[]).includes(value);
}
