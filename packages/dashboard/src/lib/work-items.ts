/**
 * The Work items view's rows, built from ledger and thread rows on the
 * server and sent to the browser as they are: only what the table shows.
 */
import { isRepository, issueUrl, pullRequestUrl, type Repository } from './links.ts';
import { buildRounds, currentStage, isStale, resultOf, statusPill, RESULT_SINCE, type Pill } from './status.ts';
import { oneLine, text } from './sanitise.ts';
import type { LedgerRow, ThreadRow } from './records.ts';

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

const SOURCE_LABELS: Record<string, string> = {
  'github-issue': 'GitHub issue',
  'github-pull-request': 'Pull request',
  'github-pull-request-review': 'PR review',
  'github-pull-request-review-comment': 'PR review comment',
  'github-pull-request-comment': 'PR comment',
  'github-workflow-run': 'Checks failed',
};

export function sourceLabel(type: string): string {
  return SOURCE_LABELS[type] ?? type;
}

export interface WorkItemSummary {
  id: string;
  title: string;
  source: { type: string; label: string; ref: string; url?: string };
  requester: string;
  repository?: Repository;
  branch?: string;
  pullRequest?: { number: number; url?: string };
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
}

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

function reference(row: LedgerRow): { ref: string; url?: string; pr?: number } {
  const item = row.workItem ?? {};
  const type = item.source?.type ?? '';
  const repo = isRepository(item.repository) ? item.repository : undefined;
  const pr = item.inReplyTo?.number ?? row.reworkOf?.prNumber ?? item.context?.pullRequest?.number;
  if (type === 'github-issue') {
    const ref = `#${text(item.source?.id)}`;
    const url = repo ? issueUrl(repo, Number(item.source?.id)) : undefined;
    return { ref, ...(url ? { url } : {}) };
  }
  if (typeof pr === 'number') {
    const url = repo ? pullRequestUrl(repo, pr) : undefined;
    return { ref: `PR #${pr}`, ...(url ? { url } : {}), pr };
  }
  return { ref: oneLine(text(item.source?.id)).slice(0, 40) };
}

function meanOf(scores: Record<string, number> | undefined): number | undefined {
  const values = Object.values(scores ?? {}).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export function summarise(row: LedgerRow, thread?: ThreadRow, now = Date.now(), resultSince = RESULT_SINCE): WorkItemSummary {
  const item = row.workItem ?? {};
  const result = resultOf(row, resultSince);
  const current = currentStage(row);
  const repository = isRepository(item.repository) ? { owner: item.repository.owner, name: item.repository.name } : undefined;
  const { ref, url } = reference(row);
  const prNumber = typeof row.prNumber === 'number' ? row.prNumber : thread?.prNumber;
  const prUrl = repository && prNumber ? pullRequestUrl(repository, prNumber) : undefined;
  const status = statusPill(row, thread, resultSince);
  const running = result === undefined && current?.stage !== 'Test';
  const waiting = result === undefined && current?.stage === 'Test';
  const cost = costOf(row);
  const mean = meanOf(row.reviewScores);
  const run = latestRun(row);
  const type = text(item.source?.type) || 'unknown';
  const endedAt = result === undefined ? undefined : (row.endedAt ?? row.updatedAt);
  return {
    id: row.workItemId,
    title: oneLine(text(item.title)) || '(no title)',
    source: { type, label: sourceLabel(type), ref, ...(url ? { url } : {}) },
    requester: oneLine(text(item.requestedBy)),
    ...(repository ? { repository } : {}),
    ...(row.branch ? { branch: oneLine(row.branch) } : {}),
    ...(prNumber ? { pullRequest: { number: prNumber, ...(prUrl ? { url: prUrl } : {}) } } : {}),
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
  };
}

const FINISHED = new Set(['pr-opened', 'pr-updated', 'no-changes']);
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

export function isFilter(value: unknown): value is Filter {
  return typeof value === 'string' && (FILTERS as readonly string[]).includes(value);
}
