/**
 * Outcomes (#165): what the pipeline concluded about one turn, built,
 * recorded and emitted here and nowhere else. Intake (a refusal), Report and
 * OpenPullRequest call `emitOutcome` at every terminal state:
 *
 * 1. validate against `contracts/outcome/v1/`;
 * 2. write `outcome/outcome.json` under the attempt's prefix;
 * 3. record `result` on the ledger row;
 * 4. put an `Outcome` event (source `factorial.outcome`) on the work bus.
 *
 * The reporter for the item's source type delivers it from the event, so the
 * state machine knows nothing of where a result is told. An outcome carries
 * pointers only; what delivery needs is in the attempt's `report.json`
 * (`lib/report-file.ts`), written before the outcome is emitted.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { putJsonArtefact } from '@factorial/artefacts';
import {
  OUTCOME_DETAIL_TYPE,
  OUTCOME_EVENT_SOURCE,
  OUTCOME_SCHEMA_VERSION,
  validateOutcome,
  type Outcome,
  type OutcomeResult,
  type RefusalReason,
} from '@factorial/outcome';
import type { WorkItem } from '@factorial/workitem';

import { requireEnv } from './env.ts';

export const OUTCOME_ARTEFACT = 'outcome/outcome.json';

export class InvalidOutcomeError extends Error {
  constructor(errors: readonly string[]) {
    super(`the outcome does not fit contracts/outcome/v1: ${errors.slice(0, 5).join('; ')}`);
    this.name = 'InvalidOutcome';
  }
}

/** What the terminal state knows; the rest is copied from the WorkItem. */
export interface OutcomeFacts {
  workItem: WorkItem;
  attempt: number;
  artefactPrefix: string;
  result: OutcomeResult;
  reason?: RefusalReason;
  threadKey?: string | undefined;
  route?: 'change' | 'refuse' | undefined;
  pullRequest?: { number: number; url: string } | undefined;
  branch?: string | undefined;
  testedSha?: string | undefined;
  savedWork?: { branch: string; commits?: number | undefined } | undefined;
  at?: string;
}

/** The outcome for a terminal state, validated. Throws `InvalidOutcome` when it does not fit the contract: a bug, not a delivery problem. */
export function buildOutcome(facts: OutcomeFacts): Outcome {
  const { workItem } = facts;
  const commits = facts.savedWork?.commits;
  const outcome: Outcome = {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    workItemId: workItem.id,
    attempt: facts.attempt,
    ...(facts.threadKey ? { threadKey: facts.threadKey } : {}),
    ...(facts.route ? { route: facts.route } : {}),
    source: { type: workItem.source.type, id: workItem.source.id, url: workItem.source.url },
    ...(workItem.inReplyTo ? { inReplyTo: { kind: workItem.inReplyTo.kind, number: workItem.inReplyTo.number } } : {}),
    repository: { provider: workItem.repository.provider, owner: workItem.repository.owner, name: workItem.repository.name },
    result: facts.result,
    ...(facts.reason ? { reason: facts.reason } : {}),
    at: facts.at ?? new Date().toISOString(),
    artefactPrefix: facts.artefactPrefix,
    ...(facts.pullRequest ? { pullRequest: { number: facts.pullRequest.number, url: facts.pullRequest.url } } : {}),
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.testedSha ? { testedSha: facts.testedSha } : {}),
    ...(facts.savedWork ? { savedWork: { branch: facts.savedWork.branch, ...(commits && commits > 0 ? { commits } : {}) } } : {}),
  };
  const checked = validateOutcome(outcome);
  if (!checked.ok) throw new InvalidOutcomeError(checked.errors);
  return checked.value;
}

/** Where an outcome is recorded and announced, so tests can stand in for each. */
export interface OutcomeSinks {
  store(prefix: string, outcome: Outcome): Promise<void>;
  record(workItemId: string, result: OutcomeResult): Promise<void>;
  put(outcome: Outcome): Promise<void>;
}

/** The ledger write: `result` on an existing row, replaced on a retry with the same value. */
export function recordResultInput(tableName: string, workItemId: string, result: OutcomeResult): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'SET #result = :result',
    ConditionExpression: 'attribute_exists(workItemId)',
    ExpressionAttributeNames: { '#result': 'result' },
    ExpressionAttributeValues: { ':result': result },
  };
}

let documents: DynamoDBDocumentClient | undefined;
let events: EventBridgeClient | undefined;

export const awsSinks: OutcomeSinks = {
  store: (prefix, outcome) => putJsonArtefact(prefix, OUTCOME_ARTEFACT, outcome),
  async record(workItemId, result) {
    documents ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
    try {
      await documents.send(new UpdateCommand(recordResultInput(requireEnv('TABLE_NAME'), workItemId, result)));
    } catch (error) {
      // No row: the item failed before Intake accepted it, so there is nothing to record on.
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  },
  async put(outcome) {
    events ??= new EventBridgeClient({});
    const response = await events.send(
      new PutEventsCommand({
        Entries: [{ EventBusName: requireEnv('EVENT_BUS_NAME'), Source: OUTCOME_EVENT_SOURCE, DetailType: OUTCOME_DETAIL_TYPE, Detail: JSON.stringify(outcome) }],
      }),
    );
    if ((response.FailedEntryCount ?? 0) > 0) {
      const entry = response.Entries?.[0];
      throw new Error(`the outcome was not put: ${entry?.ErrorCode ?? 'unknown'} ${entry?.ErrorMessage ?? ''}`.trim());
    }
  },
};

/**
 * Build, store, record and emit the outcome, in that order: the outcome is
 * recorded before anything delivers it. Each step is idempotent, so a retried
 * terminal state emits the same outcome again; the reporter delivers it once.
 * Throws on the first step that fails; the caller decides whether that fails
 * the turn.
 */
export async function emitOutcome(facts: OutcomeFacts, sinks: OutcomeSinks = awsSinks): Promise<Outcome> {
  const outcome = buildOutcome(facts);
  await sinks.store(outcome.artefactPrefix, outcome);
  await sinks.record(outcome.workItemId, outcome.result);
  await sinks.put(outcome);
  return outcome;
}
