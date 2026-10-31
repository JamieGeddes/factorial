/**
 * The channels of the `factorial-live` AppSync Events API (#194), all in the
 * one namespace `factorial`. A channel is at most five segments of at most 50
 * letters, digits and hyphens, so a run's channel is exactly five.
 */
export const LIVE_NAMESPACE = 'factorial';

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function channel(...segments: string[]): string {
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) throw new Error(`"${segment}" is not a channel segment`);
  }
  return `/${[LIVE_NAMESPACE, ...segments].join('/')}`;
}

function workItem(id: string): string {
  if (!UUID.test(id)) throw new Error(`"${id}" is not a work item id`);
  return id;
}

/** Progress of every work item. */
export const WORK_ITEMS_CHANNEL = channel('work-items');

/** Progress of one work item. */
export function workItemChannel(workItemId: string): string {
  return channel('work-items', workItem(workItemId));
}

/** One agent run's events: `build/1`, `build/2`, `review/1`. */
export function runChannel(workItemId: string, stage: string, round: number): string {
  if (!Number.isInteger(round) || round < 1) throw new Error(`round ${round} is not a positive integer`);
  return channel('runs', workItem(workItemId), stage, String(round));
}

/** Every run of one work item, for a subscriber: the wildcard covers each stage and round. */
export function runsChannel(workItemId: string): string {
  return `${channel('runs', workItem(workItemId))}/*`;
}
