/**
 * The progress record (#15): every stage a work item runs has one entry on
 * its ledger row, under `stages`, and every transition is announced as a
 * WorkItemProgress event (`contracts/progress/v1/`) on the `factorial-work`
 * bus. This module is the only place either is written, so a stage cannot
 * record one without the other: the ledger first, then the event.
 *
 * Each write is conditional, so a retried Lambda or a replayed task records
 * nothing twice; it puts the event again, with the same `eventId`, built from
 * what the ledger already holds. Events are therefore at least once.
 *
 * Recording is best effort: a failure is reported through `onError` and never
 * raised, so the progress record can never fail a stage. Every write requires
 * the ledger row to exist, so a write for an item not yet accepted (or with
 * no row) creates nothing.
 *
 * What became of the pull request an item opened (#204) is the one event
 * recorded elsewhere: `factorial-thread-outcome` writes it on the thread,
 * then announces it here for the item that opened the pull request.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { redactSecrets } from '@factorial/artefacts';

import schema from '../../../contracts/progress/v1/progress-event.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const PROGRESS_SOURCE = 'factorial.progress';
export const PROGRESS_DETAIL_TYPE = 'WorkItemProgress';
/** The stage name of the work item's own end. */
export const WORK_ITEM_STAGE = 'WorkItem';
/** The stage name of what became of the pull request the work item opened. */
export const PULL_REQUEST_STAGE = 'PullRequest';

/** Stages that run once per build round; every other stage runs at most once per work item. */
const ROUND_STAGES = new Set(['Build', 'SaveWork', 'ContinueBuild']);
const STAGE_PATTERN = /^[A-Z][A-Za-z]*$/;

export type StageOutcome = 'succeeded' | 'failed';
/** What became of a pull request: merged, or closed without merging. */
export type PullRequestState = 'merged' | 'closed';
export type Transition = 'started' | StageOutcome | 'ended' | PullRequestState;

export interface StageError {
  name: string;
  message?: string;
}

/** An agent run's record on the end of its stage, as metadata. */
export interface RunEntry {
  role?: string;
  runtimeName?: string;
  runtimeVersion?: string;
  runContract?: number;
  harness?: { name: string; version?: string };
  modelId?: string;
  effort?: string;
  sessionId?: string;
  toolCalls?: number;
  turns?: number;
  durationSeconds?: number;
  stopReason?: string;
  outcome?: 'complete' | 'incomplete' | 'failed';
  usage?: Record<string, number>;
  costUsd?: number;
  transcriptKey?: string;
  usageKey?: string;
}

/** One entry under the ledger row's `stages`. */
export interface StageEntry {
  round?: number;
  startedAt?: string;
  endedAt?: string;
  outcome?: StageOutcome;
  error?: StageError;
  run?: RunEntry;
}

/** The parts of a ledger row the progress record reads. */
export interface LedgerRow {
  workItemId: string;
  workItem?: { source?: { type?: string; url?: string }; repository?: { provider?: string; owner?: string; name?: string } };
  attempt?: number;
  threadKey?: string;
  status?: string;
  endedAt?: string;
  stages?: Record<string, StageEntry>;
}

export interface ProgressEvent {
  schemaVersion: 1;
  eventId: string;
  workItemId: string;
  attempt?: number;
  threadKey?: string;
  source: { type: string; url: string };
  repository: { provider: 'github'; owner: string; name: string };
  stage: string;
  round?: number;
  transition: Transition;
  at: string;
  status?: string;
  error?: StageError;
  run?: RunEntry;
  pullRequest?: { number: number; by: string; mergeCommit?: string };
}

/** What became of a pull request, as its thread records it (`outcome` on the `factorial-threads` row). */
export interface PullRequestOutcome {
  state: PullRequestState;
  /** When it closed. */
  at: string;
  /** Who merged it, or who closed it without merging. */
  by: string;
  /** For a merge: the commit it made on the base branch. */
  mergeCommit?: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<ProgressEvent>(schema);

/** Validates an event's detail against the schema; returns the problems, empty when it fits. */
export function progressEventErrors(event: unknown): string[] {
  if (validate(event)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? e.keyword}`);
}

/** Whether a stage name can be recorded: a state machine state name. */
export function isStageName(stage: unknown): stage is string {
  return typeof stage === 'string' && stage.length <= 64 && STAGE_PATTERN.test(stage) && stage !== WORK_ITEM_STAGE && stage !== PULL_REQUEST_STAGE;
}

/** The round a stage is recorded under: only a round stage, and only after the first round. */
export function roundOf(stage: string, round: number | undefined): number | undefined {
  return ROUND_STAGES.has(stage) && round !== undefined && Number.isInteger(round) && round > 1 ? round : undefined;
}

/** The key of a stage's entry under `stages`: `Build`, `Build#2`, `Test`. */
export function stageKey(stage: string, round?: number): string {
  const r = roundOf(stage, round);
  return r === undefined ? stage : `${stage}#${r}`;
}

/** The stage and round a key names. */
export function parseStageKey(key: string): { stage: string; round?: number } {
  const [stage = key, round] = key.split('#');
  return round === undefined ? { stage } : { stage, round: Number(round) };
}

/** An error as the progress record keeps it: a name, and a short redacted message. */
export function stageError(name: string, message?: string): StageError {
  const cleanName = redactSecrets(name).slice(0, 200) || 'Error';
  if (!message) return { name: cleanName };
  return { name: cleanName, message: redactSecrets(message).slice(0, 1000) };
}

/** The event for one transition, built only from the ledger row, so every copy is the same. Undefined when the row lacks the WorkItem. */
export function progressEvent(
  row: LedgerRow,
  key: string,
  transition: Transition,
  at: string,
  extra: Pick<ProgressEvent, 'status' | 'error' | 'run' | 'pullRequest'> = {},
): ProgressEvent | undefined {
  const source = row.workItem?.source;
  const repository = row.workItem?.repository;
  if (!source?.type || !source.url || repository?.provider !== 'github' || !repository.owner || !repository.name) return undefined;
  const { stage, round } = parseStageKey(key);
  return {
    schemaVersion: 1,
    eventId: `${row.workItemId}:${key}:${transition}`,
    workItemId: row.workItemId,
    ...(row.attempt !== undefined ? { attempt: row.attempt } : {}),
    ...(row.threadKey ? { threadKey: row.threadKey } : {}),
    source: { type: source.type, url: source.url },
    repository: { provider: 'github', owner: repository.owner, name: repository.name },
    stage,
    ...(round !== undefined ? { round } : {}),
    transition,
    at,
    ...extra,
  };
}

/** A change to the ledger row, applied only when its condition holds. */
export type LedgerChange =
  /** Set a stage's entry, if it has none. */
  | { kind: 'put'; key: string; entry: StageEntry }
  /** End a started stage, if it has not ended. */
  | { kind: 'end'; key: string; fields: Pick<StageEntry, 'endedAt' | 'outcome' | 'error' | 'run'> }
  /** Mark the work item ended, if it has not been. */
  | { kind: 'work-item-end'; at: string };

/** The row after the change, or before it when the condition did not hold; no row when there is none. */
export interface LedgerResult {
  applied: boolean;
  row?: LedgerRow;
}

export interface Ledger {
  apply(workItemId: string, change: LedgerChange): Promise<LedgerResult>;
}

/** The ledger's conditional writes on one row, in memory: for tests. */
export class MemoryLedger implements Ledger {
  /** How many changes were applied. */
  writes = 0;
  row: LedgerRow | undefined;

  constructor(row?: LedgerRow) {
    this.row = row;
  }

  async apply(_workItemId: string, change: LedgerChange): Promise<LedgerResult> {
    if (!this.row) return { applied: false };
    const before = structuredClone(this.row);
    const stages = (this.row.stages ??= {});
    const holds =
      change.kind === 'put'
        ? stages[change.key] === undefined
        : change.kind === 'end'
          ? stages[change.key] !== undefined && stages[change.key]?.endedAt === undefined
          : this.row.endedAt === undefined;
    if (!holds) return { applied: false, row: before };
    this.writes += 1;
    if (change.kind === 'put') stages[change.key] = structuredClone(change.entry);
    else if (change.kind === 'end') Object.assign(stages[change.key] ?? {}, structuredClone(change.fields));
    else this.row.endedAt = change.at;
    return { applied: true, row: structuredClone(this.row) };
  }
}

/** Events kept in memory: for tests. */
export class MemoryBus implements Bus {
  events: ProgressEvent[] = [];

  async put(event: ProgressEvent): Promise<void> {
    this.events.push(event);
  }
}

export interface Bus {
  put(event: ProgressEvent): Promise<void>;
}

export interface RecorderOptions {
  now?: () => string;
  onError?: (message: string, fields: Record<string, unknown>) => void;
}

export class ProgressRecorder {
  private readonly ledger: Ledger;
  private readonly bus: Bus;
  private readonly now: () => string;
  private readonly onError: (message: string, fields: Record<string, unknown>) => void;

  constructor(ledger: Ledger, bus: Bus, options: RecorderOptions = {}) {
    this.ledger = ledger;
    this.bus = bus;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError ?? (() => {});
  }

  /** Record that a stage started. */
  async started(workItemId: string, stage: string, round?: number): Promise<void> {
    const key = stageKey(stage, round);
    await this.guard('started', workItemId, key, async () => {
      const r = roundOf(stage, round);
      const result = await this.ledger.apply(workItemId, { kind: 'put', key, entry: { ...(r !== undefined ? { round: r } : {}), startedAt: this.now() } });
      const entry = result.row?.stages?.[key];
      if (result.row && entry?.startedAt) await this.announce(progressEvent(result.row, key, 'started', entry.startedAt));
    });
  }

  /**
   * Record that a stage ended. A stage with no entry (its start was never
   * recorded: a task that never started, a stage closed by a later one) gets
   * an entry with only its end. A repeat puts the recorded end's event
   * again, unless `ifOpen`: a later stage closing this one, which says
   * nothing new when the stage has ended. Returns the row after the write.
   */
  async ended(
    workItemId: string,
    stage: string,
    round: number | undefined,
    outcome: StageOutcome,
    detail: { error?: StageError; run?: RunEntry; ifOpen?: boolean } = {},
  ): Promise<LedgerRow | undefined> {
    const key = stageKey(stage, round);
    return this.guard('ended', workItemId, key, async () => {
      const fields = { endedAt: this.now(), outcome, ...(detail.error ? { error: detail.error } : {}), ...(detail.run ? { run: detail.run } : {}) };
      let result = await this.ledger.apply(workItemId, { kind: 'end', key, fields });
      if (!result.applied && result.row && !result.row.stages?.[key]) {
        const r = roundOf(stage, round);
        result = await this.ledger.apply(workItemId, { kind: 'put', key, entry: { ...(r !== undefined ? { round: r } : {}), ...fields } });
      }
      const entry = result.row?.stages?.[key];
      if (!result.applied && detail.ifOpen) return result.row;
      if (result.row && entry?.endedAt && entry.outcome) {
        await this.announce(
          progressEvent(result.row, key, entry.outcome, entry.endedAt, {
            ...(entry.error ? { error: entry.error } : {}),
            ...(entry.run ? { run: entry.run } : {}),
          }),
        );
      }
      return result.row;
    });
  }

  /**
   * Record that the work item ended, with the status its row holds. Any
   * stage still open is ended first as failed (with `error`, or a note that
   * it never recorded its end), so the record has no stage left running.
   */
  async workItemEnded(workItemId: string, error?: StageError): Promise<void> {
    await this.guard('work item ended', workItemId, WORK_ITEM_STAGE, async () => {
      const result = await this.ledger.apply(workItemId, { kind: 'work-item-end', at: this.now() });
      const row = result.row;
      if (!row) return;
      for (const [key, entry] of Object.entries(row.stages ?? {})) {
        if (!entry.startedAt || entry.endedAt) continue;
        const { stage, round } = parseStageKey(key);
        await this.ended(workItemId, stage, round, 'failed', {
          error: error ?? stageError('NotEnded', 'The work item ended before this stage recorded its end.'),
        });
      }
      if (row.endedAt && row.status) await this.announce(progressEvent(row, WORK_ITEM_STAGE, 'ended', row.endedAt, { status: row.status }));
    });
  }

  /**
   * Announce what became of the pull request the item on `row` opened, once
   * its thread records it. The thread is the record, so nothing is written
   * here; a repeat puts the same event, with the same `eventId`, again.
   */
  async pullRequestClosed(row: LedgerRow, prNumber: number, outcome: PullRequestOutcome): Promise<void> {
    await this.guard('pull request closed', row.workItemId, PULL_REQUEST_STAGE, async () => {
      const pullRequest = { number: prNumber, by: outcome.by, ...(outcome.state === 'merged' && outcome.mergeCommit ? { mergeCommit: outcome.mergeCommit } : {}) };
      await this.announce(progressEvent(row, PULL_REQUEST_STAGE, outcome.state, outcome.at, { pullRequest }));
    });
  }

  private async announce(event: ProgressEvent | undefined): Promise<void> {
    if (!event) {
      this.onError('progress event not built', { reason: 'the ledger row has no readable WorkItem' });
      return;
    }
    const errors = progressEventErrors(event);
    if (errors.length > 0) {
      this.onError('progress event invalid', { eventId: event.eventId, errors: errors.slice(0, 5) });
      return;
    }
    await this.bus.put(event);
  }

  private async guard<T>(what: string, workItemId: string, key: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      this.onError('progress not recorded', { transition: what, workItemId, stage: key, error });
      return undefined;
    }
  }
}

/** The ledger change as a DynamoDB update on the `factorial-work-items` row. */
export function updateFor(tableName: string, workItemId: string, change: LedgerChange): UpdateCommandInput {
  const base = { TableName: tableName, Key: { workItemId }, ReturnValues: 'ALL_NEW', ReturnValuesOnConditionCheckFailure: 'ALL_OLD' } as const;
  switch (change.kind) {
    case 'put':
      return {
        ...base,
        UpdateExpression: 'SET #stages.#key = :entry',
        ConditionExpression: 'attribute_exists(workItemId) AND attribute_not_exists(#stages.#key)',
        ExpressionAttributeNames: { '#stages': 'stages', '#key': change.key },
        ExpressionAttributeValues: { ':entry': change.entry },
      };
    case 'end': {
      const names: Record<string, string> = { '#stages': 'stages', '#key': change.key, '#endedAt': 'endedAt' };
      const values: Record<string, unknown> = {};
      const sets: string[] = [];
      for (const [field, value] of Object.entries(change.fields)) {
        if (value === undefined) continue;
        names[`#${field}`] = field;
        values[`:${field}`] = value;
        sets.push(`#stages.#key.#${field} = :${field}`);
      }
      return {
        ...base,
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(#stages.#key) AND attribute_not_exists(#stages.#key.#endedAt)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      };
    }
    case 'work-item-end':
      return {
        ...base,
        UpdateExpression: 'SET #endedAt = :at',
        ConditionExpression: 'attribute_exists(workItemId) AND attribute_not_exists(#endedAt)',
        ExpressionAttributeNames: { '#endedAt': 'endedAt' },
        ExpressionAttributeValues: { ':at': change.at },
      };
  }
}

/** The ledger in DynamoDB. A row accepted before #15 has no `stages`; it gets an empty map on its first stage write. */
export class DynamoLedger implements Ledger {
  private readonly tableName: string;
  private readonly documents: DynamoDBDocumentClient;

  constructor(tableName: string, documents?: DynamoDBDocumentClient) {
    this.tableName = tableName;
    this.documents = documents ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  }

  async apply(workItemId: string, change: LedgerChange): Promise<LedgerResult> {
    try {
      return await this.send(workItemId, change);
    } catch (error) {
      if (change.kind !== 'put' || (error as { name?: string }).name !== 'ValidationException') throw error;
      await this.addStages(workItemId);
      return this.send(workItemId, change);
    }
  }

  private async send(workItemId: string, change: LedgerChange): Promise<LedgerResult> {
    try {
      const result = await this.documents.send(new UpdateCommand(updateFor(this.tableName, workItemId, change)));
      return { applied: true, row: result.Attributes as LedgerRow };
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      // lib-dynamodb does not unmarshall the item an exception carries.
      const item = (error as { Item?: Parameters<typeof unmarshall>[0] }).Item;
      return { applied: false, ...(item ? { row: unmarshall(item) as LedgerRow } : {}) };
    }
  }

  private async addStages(workItemId: string): Promise<void> {
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { workItemId },
          UpdateExpression: 'SET #stages = :empty',
          ConditionExpression: 'attribute_exists(workItemId) AND attribute_not_exists(#stages)',
          ExpressionAttributeNames: { '#stages': 'stages' },
          ExpressionAttributeValues: { ':empty': {} },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}

/** The `factorial-work` bus. */
export class EventBridgeBus implements Bus {
  private readonly busName: string;
  private readonly client: EventBridgeClient;

  constructor(busName: string, client?: EventBridgeClient) {
    this.busName = busName;
    this.client = client ?? new EventBridgeClient({});
  }

  async put(event: ProgressEvent): Promise<void> {
    const result = await this.client.send(
      new PutEventsCommand({
        Entries: [{ EventBusName: this.busName, Source: PROGRESS_SOURCE, DetailType: PROGRESS_DETAIL_TYPE, Detail: JSON.stringify(event) }],
      }),
    );
    if ((result.FailedEntryCount ?? 0) > 0) {
      const entry = result.Entries?.[0];
      throw new Error(`the progress event was not put: ${entry?.ErrorCode ?? 'unknown'} ${entry?.ErrorMessage ?? ''}`.trim());
    }
  }
}

let clients: { tableName: string; busName: string; ledger: Ledger; bus: Bus } | undefined;

/**
 * A recorder on the ledger and bus the environment names (`TABLE_NAME`,
 * `EVENT_BUS_NAME`). The clients are reused across calls; make one recorder
 * per invocation, so its errors are logged with that invocation's key.
 */
export function progressRecorder(env: NodeJS.ProcessEnv, options: RecorderOptions = {}): ProgressRecorder {
  const tableName = env.TABLE_NAME;
  const busName = env.EVENT_BUS_NAME;
  if (!tableName || !busName) {
    const missing = !tableName ? 'TABLE_NAME' : 'EVENT_BUS_NAME';
    const failing = { apply: () => Promise.reject(new Error(`Missing required environment variable ${missing}`)) };
    return new ProgressRecorder(failing, { put: () => Promise.resolve() }, options);
  }
  if (clients?.tableName !== tableName || clients.busName !== busName) {
    clients = { tableName, busName, ledger: new DynamoLedger(tableName), bus: new EventBridgeBus(busName) };
  }
  return new ProgressRecorder(clients.ledger, clients.bus, options);
}
