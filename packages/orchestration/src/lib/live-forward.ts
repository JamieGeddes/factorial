/**
 * Work-item progress on the live channel (#194): `factorial-live-forward`
 * takes two kinds of event and publishes each to `/factorial/work-items` and
 * `/factorial/work-items/<workItemId>`.
 *
 * - **Execution status changes** of the `factorial-work` state machine, which
 *   AWS sends to the default bus. EventBridge names the execution (#203), so
 *   the work item's id comes from the execution's input, the WorkItem's `id`.
 *   Published as `{ eventId, workItemId, transition, at }`; nothing of the
 *   input, the output or an error's cause.
 * - **WorkItemProgress events** (#15) from the work bus, published as they
 *   are, once each contract check passes.
 *
 * Both are at least once, so every message carries `eventId` and a subscriber
 * drops repeats; the forwarder also drops repeats it has seen while warm. It
 * holds `appsync:EventPublish` on the namespace and nothing else, so it keeps
 * no record of its own.
 */
import { WORK_ITEMS_CHANNEL, workItemChannel, type PublishBatch } from '@factorial/live';
import { PROGRESS_DETAIL_TYPE, PROGRESS_SOURCE, progressEventErrors } from '@factorial/progress';

export const EXECUTION_SOURCE = 'aws.states';
export const EXECUTION_DETAIL_TYPE = 'Step Functions Execution Status Change';

const TRANSITIONS: Record<string, ExecutionTransition> = {
  RUNNING: 'started',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed-out',
  ABORTED: 'aborted',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ExecutionTransition = 'started' | 'succeeded' | 'failed' | 'timed-out' | 'aborted';

export interface ExecutionNotice {
  eventId: string;
  workItemId: string;
  transition: ExecutionTransition;
  at: string;
}

export interface BusEvent {
  source?: unknown;
  'detail-type'?: unknown;
  time?: unknown;
  detail?: unknown;
}

export type Notice = { workItemId: string; eventId: string; message: Record<string, unknown> };

/** Why an event was not forwarded, for the log; undefined when it was. */
export type Skip = { reason: string; fields?: Record<string, unknown> };

const isoOf = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
};

/** The work item an execution ran: the WorkItem's id in its input. */
export function workItemIdOfInput(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  try {
    const id = (JSON.parse(input) as { id?: unknown } | null)?.id;
    return typeof id === 'string' && UUID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function executionNotice(event: BusEvent): Notice | Skip {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const transition = typeof detail.status === 'string' ? TRANSITIONS[detail.status] : undefined;
  if (!transition) return { reason: 'status not forwarded', fields: { status: detail.status } };
  const workItemId = workItemIdOfInput(detail.input);
  if (!workItemId) {
    // The input is left out when it and the output together pass 248 KiB.
    return { reason: 'no work item id in the execution input', fields: { executionArn: detail.executionArn, inputIncluded: (detail.inputDetails as { included?: unknown } | undefined)?.included } };
  }
  const at = (transition === 'started' ? isoOf(detail.startDate) : isoOf(detail.stopDate)) ?? isoOf(event.time) ?? new Date().toISOString();
  const eventId = `${workItemId}:Execution:${transition}`;
  const message: ExecutionNotice = { eventId, workItemId, transition, at };
  return { workItemId, eventId, message: { ...message } };
}

export function progressNotice(event: BusEvent): Notice | Skip {
  const errors = progressEventErrors(event.detail);
  if (errors.length > 0) return { reason: 'progress event does not meet its contract', fields: { errors: errors.slice(0, 5) } };
  const detail = event.detail as { workItemId: string; eventId: string };
  return { workItemId: detail.workItemId, eventId: detail.eventId, message: event.detail as Record<string, unknown> };
}

/** What to publish for one bus event, or why not. */
export function noticeOf(event: BusEvent): Notice | Skip {
  if (event.source === EXECUTION_SOURCE && event['detail-type'] === EXECUTION_DETAIL_TYPE) return executionNotice(event);
  if (event.source === PROGRESS_SOURCE && event['detail-type'] === PROGRESS_DETAIL_TYPE) return progressNotice(event);
  return { reason: 'not an event the forwarder reads', fields: { source: event.source, detailType: event['detail-type'] } };
}

/** The ids already forwarded by this warm container, oldest first. */
export class RecentIds {
  private readonly ids = new Set<string>();
  private readonly max: number;

  constructor(max = 1000) {
    this.max = max;
  }

  /** Records `id`; false when it was already there. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }

  delete(id: string): void {
    this.ids.delete(id);
  }
}

export interface ForwardDeps {
  publish: PublishBatch;
  recent: RecentIds;
  log: { info(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Publishes one bus event to both work-item channels. A publish that fails
 * throws, so Lambda retries the event; a refused event counts as failed too.
 */
export async function forward(event: BusEvent, deps: ForwardDeps): Promise<'forwarded' | 'repeat' | 'skipped'> {
  const notice = noticeOf(event);
  if (!('message' in notice)) {
    deps.log.info('not forwarded', { reason: notice.reason, ...notice.fields });
    return 'skipped';
  }
  if (!deps.recent.add(notice.eventId)) return 'repeat';
  const text = JSON.stringify(notice.message);
  try {
    for (const channel of [WORK_ITEMS_CHANNEL, workItemChannel(notice.workItemId)]) {
      const { failed } = await deps.publish(channel, [text]);
      if (failed > 0) throw new Error(`the service refused the event on ${channel}`);
    }
  } catch (error) {
    // A retry must not be taken for a repeat.
    deps.recent.delete(notice.eventId);
    throw error;
  }
  deps.log.info('forwarded', { workItemId: notice.workItemId, eventId: notice.eventId });
  return 'forwarded';
}
