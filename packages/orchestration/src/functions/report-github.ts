/**
 * factorial-report-github: the GitHub reporter's Lambda (#165). Reached by
 * the rules that route `Outcome` and `WorkItemProgress` events from GitHub
 * sources to it; `reporters/github/` decides what each one needs.
 */
import { getTextArtefact } from '@factorial/artefacts';
import { createLogger } from '@factorial/log';

import { DynamoDeliveryLedger } from '../lib/delivery-ledger.ts';
import { botLogin, repositoryClient } from '../lib/github.ts';
import { DynamoNotifyLedger } from '../lib/notified.ts';
import { MAX_REPORT_BYTES, REPORT_ARTEFACT } from '../lib/report-file.ts';
import { handleEvent, type BusEvent, type ReporterDeps } from '../reporters/github/index.ts';

const ledger = new DynamoNotifyLedger();
const deliveries = new DynamoDeliveryLedger();

async function readReport(prefix: string): Promise<string | undefined> {
  const read = await getTextArtefact(prefix, REPORT_ARTEFACT, MAX_REPORT_BYTES);
  if (read?.truncated) throw new Error(`report.json under ${prefix} is over ${MAX_REPORT_BYTES} bytes`);
  return read?.text;
}

export async function handler(event: BusEvent): Promise<void> {
  const log = createLogger('report-github');
  const deps: ReporterDeps = { ledger, deliveries, github: repositoryClient, readReport, botLogin, log, now: () => new Date() };
  try {
    await handleEvent(event, deps);
  } catch (error) {
    const id = (event.detail as { workItemId?: unknown } | null | undefined)?.workItemId;
    log.with({ workItemId: typeof id === 'string' ? id : undefined }).error('failed', { error });
    throw error;
  }
}
