/**
 * Live forward: work-item progress on the live channel (lib/live-forward.ts,
 * #194). Reached by two rules: the state machine's execution status changes on
 * the default bus, and WorkItemProgress events on the work bus.
 */
import { httpPublisher } from '@factorial/live';
import { createLogger } from '@factorial/log';

import { requireEnv } from '../lib/env.ts';
import { RecentIds, forward, type BusEvent } from '../lib/live-forward.ts';

const recent = new RecentIds();

export async function handler(event: BusEvent): Promise<void> {
  const log = createLogger('live-forward');
  const publish = httpPublisher({ httpDomain: requireEnv('LIVE_HTTP_DOMAIN'), region: requireEnv('AWS_REGION') });
  try {
    await forward(event, { publish, recent, log });
  } catch (error) {
    log.error('failed', { error });
    throw error;
  }
}
