/**
 * `report.json`: every terminal state writes one under the attempt's prefix,
 * before it emits the outcome (#165). Its `outcome` and `reason` are the
 * record; `delivery` carries what a reporter needs to tell the requester,
 * as facts rather than text, so each source's reporter words them its own
 * way. The orchestrator fills it from what it holds, redacted on the way in
 * by `putJsonArtefact`; agent text in it (the builder's summary, a point's
 * answer) is capped again when a reporter renders it.
 *
 * It is the only key a reporter reads, granted by key in the template.
 */
import type { WorkItemReworkCause } from '@factorial/workitem';

import type { ReviewOutcome, TestResult } from '../functions/pr-body.ts';
import type { PrFacts } from './pr-facts.ts';
import type { ReworkPoint } from './rework-points.ts';

export const REPORT_ARTEFACT = 'report.json';
/** Far above any real report: the cap guards the reader, not the writer. */
export const MAX_REPORT_BYTES = 512 * 1024;

export type ReportStatus = 'no-changes' | 'tests-failed' | 'failed' | 'invalid-plan';

/** What a turn that opened or updated no pull request says. */
export interface ReportFacts {
  status: ReportStatus;
  /** The turn continues a pull request, whose branch carries anything pushed. */
  rework: boolean;
  /** no-changes: what the agent said, as Collect read it. */
  agentSaid?: string;
  /** tests-failed: the failed run. */
  testRunUrl?: string;
  /** The work branch, once Prepare has named it. */
  branch?: string;
  /** The builder's session; for a step failure before Prepare, the work item id. */
  sessionId?: string;
  /** invalid-plan: the validator's problems, each already a redacted code span. */
  planProblems?: string[];
  /** failed: the builder reached its iteration or time limit. */
  incomplete?: boolean;
  /** failed: the round that failed, when the build ran in rounds. */
  buildRound?: number;
  /** failed: the error's name. Never its cause, which can hold command output. */
  errorName?: string;
  /** failed: untested work pushed to the branch. */
  savedWork?: { branch: string; commits?: number };
}

/** The run details table's values: what the orchestrator knows, never agent text. */
export interface RunDetails {
  source: { type: string; id: string; url: string };
  requestedBy: string;
  branch: string;
  factorialVersion: string;
  sessionId: string;
  artefactPrefix: string;
}

/** What the reply to a rework is built from. */
export interface ReworkReplyFacts {
  cause: WorkItemReworkCause;
  requestedBy: string;
  headSha: string;
  test: TestResult;
  /** Who raised each point and where, numbered as in rework.md. */
  points: ReworkPoint[];
  /** The builder's summary.md, redacted. */
  summaryText: string;
  review?: ReviewOutcome;
  facts?: PrFacts | null;
  runDetails: RunDetails;
}

export type Delivery =
  /** The outcome's pointers are all a reporter needs. */
  | { kind: 'pr-opened' }
  | { kind: 'rework-reply'; reply: ReworkReplyFacts; reviewers: string[] }
  | { kind: 'report'; facts: ReportFacts }
  /** `reply` when a person asked and should be answered; orchestrator text only. */
  | { kind: 'refusal'; reply?: string };

export interface ReportFile {
  outcome: string;
  reason: string;
  error?: { Error?: string | undefined; Cause?: string | undefined };
  savedWork?: boolean;
  delivery?: Delivery;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function reportFactsProblem(facts: unknown): string | undefined {
  if (!isObject(facts)) return 'facts is not an object';
  if (!['no-changes', 'tests-failed', 'failed', 'invalid-plan'].includes(facts.status as string)) return 'facts.status is not a report status';
  if (typeof facts.rework !== 'boolean') return 'facts.rework is not a boolean';
  for (const key of ['agentSaid', 'testRunUrl', 'branch', 'sessionId', 'errorName'] as const) {
    if (!optional(facts[key], isString)) return `facts.${key} is not a string`;
  }
  if (!optional(facts.planProblems, isStringArray)) return 'facts.planProblems is not a list of strings';
  if (!optional(facts.incomplete, (v) => typeof v === 'boolean')) return 'facts.incomplete is not a boolean';
  if (!optional(facts.buildRound, isCount)) return 'facts.buildRound is not a count';
  if (!optional(facts.savedWork, (v) => isObject(v) && isString(v.branch) && optional(v.commits, isCount))) return 'facts.savedWork is malformed';
  return undefined;
}

function replyProblem(reply: unknown): string | undefined {
  if (!isObject(reply)) return 'reply is not an object';
  if (!['review', 'checks-failed', 'comment'].includes(reply.cause as string)) return 'reply.cause is not a rework cause';
  for (const key of ['requestedBy', 'headSha', 'summaryText'] as const) {
    if (!isString(reply[key])) return `reply.${key} is not a string`;
  }
  if (!isObject(reply.test)) return 'reply.test is not an object';
  if (!Array.isArray(reply.points) || !reply.points.every((p) => isObject(p) && isString(p.author))) return 'reply.points is malformed';
  const details = reply.runDetails;
  if (!isObject(details) || !isObject(details.source)) return 'reply.runDetails is malformed';
  for (const key of ['requestedBy', 'branch', 'factorialVersion', 'sessionId', 'artefactPrefix'] as const) {
    if (!isString(details[key])) return `reply.runDetails.${key} is not a string`;
  }
  return undefined;
}

function deliveryProblem(delivery: unknown): string | undefined {
  if (!isObject(delivery)) return 'delivery is not an object';
  switch (delivery.kind) {
    case 'pr-opened':
      return undefined;
    case 'report':
      return reportFactsProblem(delivery.facts);
    case 'rework-reply':
      return replyProblem(delivery.reply) ?? (isStringArray(delivery.reviewers) ? undefined : 'reviewers is not a list of logins');
    case 'refusal':
      return optional(delivery.reply, isString) ? undefined : 'reply is not a string';
    default:
      return 'delivery.kind is unknown';
  }
}

/** Read a stored report back: its shape is checked before a reporter acts on it. */
export function parseReportFile(text: string): { ok: true; value: ReportFile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'report.json is not valid JSON' };
  }
  if (!isObject(parsed)) return { ok: false, error: 'report.json is not an object' };
  if (!isString(parsed.outcome) || !isString(parsed.reason)) return { ok: false, error: 'report.json has no outcome or reason' };
  if (parsed.delivery !== undefined) {
    const problem = deliveryProblem(parsed.delivery);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: parsed as unknown as ReportFile };
}
