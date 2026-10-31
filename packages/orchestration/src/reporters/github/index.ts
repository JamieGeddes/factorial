/**
 * The notifier seam: progress events, dispatched on `source.type` to one
 * notifier per source type. A source type with no notifier is ignored. To
 * notify another kind of source, add a module and one line to `notifiers`.
 *
 * The `factorial-progress-notify` rule (templates/orchestration.yml) sends the
 * notifier only the events a notifier acts on, today a round-1 Build start. A
 * notifier that acts on other events widens that rule's pattern in the same
 * change; the modules still decide for themselves.
 */
import { progressEventErrors, type ProgressEvent } from '@factorial/progress';
import { TRIGGER_TYPES } from '@factorial/workitem';

import type { Logger } from '../lib/log.ts';
import { githubIssueNotifier } from './github-issue.ts';
import type { Notifier, NotifierDeps } from './types.ts';

export type { Notifier, NotifierDeps } from './types.ts';

export const notifiers: Readonly<Record<string, Notifier>> = {
  [TRIGGER_TYPES.githubIssue]: githubIssueNotifier,
};

/** Handle one `WorkItemProgress` event's detail. An invalid event or an unknown source type is logged and ignored. */
export async function handleProgress(detail: unknown, deps: Omit<NotifierDeps, 'log'> & { log: Logger }): Promise<void> {
  const errors = progressEventErrors(detail);
  if (errors.length > 0) {
    deps.log.error('progress event ignored', { errors: errors.slice(0, 5) });
    return;
  }
  const event = detail as ProgressEvent;
  const log = deps.log.with({ workItemId: event.workItemId, ...(event.attempt !== undefined ? { attempt: event.attempt } : {}) });
  const notifier = Object.hasOwn(notifiers, event.source.type) ? notifiers[event.source.type] : undefined;
  if (!notifier) {
    log.info('no notifier for source type', { sourceType: event.source.type });
    return;
  }
  await notifier(event, { ...deps, log });
}
