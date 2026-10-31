/**
 * Notify: tell a requester that their work has started. Reached by the rule
 * that routes `WorkItemProgress` events to it; the notifier for the event's
 * source type decides whether the event is one it acts on.
 */
import { createLogger } from '@factorial/log';

import { repositoryClient } from '../lib/github.ts';
import { DynamoNotifyLedger } from '../lib/notified.ts';
import { handleProgress } from '../notifiers/index.ts';

const ledger = new DynamoNotifyLedger();

/** An EventBridge event whose `detail` is the WorkItemProgress. */
export async function handler(event: { detail?: unknown }): Promise<void> {
  const log = createLogger('notify');
  try {
    await handleProgress(event.detail, { ledger, github: repositoryClient, log, now: () => new Date().toISOString() });
  } catch (error) {
    const id = (event.detail as { workItemId?: unknown } | null | undefined)?.workItemId;
    log.with({ workItemId: typeof id === 'string' ? id : undefined }).error('failed', { error });
    throw error;
  }
}
