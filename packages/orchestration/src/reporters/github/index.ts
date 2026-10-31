/**
 * The GitHub reporter (#165): tells requesters on GitHub what became of
 * their work. One reporter per source type, each its own Lambda selected by
 * EventBridge rules on `source.type`; this one serves every `github-*`
 * source. It takes two kinds of event from the work bus:
 *
 * - `Outcome` (`contracts/outcome/v1/`): the turn's end, delivered as one
 *   comment where the request came from (`deliver.ts`).
 * - `WorkItemProgress` (`contracts/progress/v1/`): the started notice on a
 *   labelled issue (`started.ts`), so "started" and "finished" come from one
 *   place.
 *
 * Its rules (templates/orchestration.yml) send it only the events it acts
 * on; it still checks each event itself. An invalid event, or one from a
 * source type it does not serve, is logged and ignored.
 */
import { OUTCOME_DETAIL_TYPE, validateOutcome } from '@factorial/outcome';
import { PROGRESS_DETAIL_TYPE, progressEventErrors, type ProgressEvent } from '@factorial/progress';

import { deliverOutcome } from './deliver.ts';
import { noticeStarted } from './started.ts';
import type { ReporterDeps } from './types.ts';

export type { ReporterDeps } from './types.ts';

/** The source types this reporter serves. */
export const servesSource = (type: string): boolean => type.startsWith('github-');

/** One EventBridge event from the work bus. */
export interface BusEvent {
  'detail-type'?: unknown;
  detail?: unknown;
}

const idOf = (detail: unknown): string | undefined => {
  const id = (detail as { workItemId?: unknown } | null | undefined)?.workItemId;
  return typeof id === 'string' ? id : undefined;
};

export async function handleEvent(event: BusEvent, deps: ReporterDeps): Promise<void> {
  const workItemId = idOf(event.detail);
  const log = deps.log.with(workItemId ? { workItemId } : {});
  if (event['detail-type'] === OUTCOME_DETAIL_TYPE) {
    const checked = validateOutcome(event.detail);
    if (!checked.ok) {
      log.error('outcome ignored', { errors: checked.errors.slice(0, 5) });
      return;
    }
    const outcome = checked.value;
    if (!servesSource(outcome.source.type)) {
      log.info('not a GitHub source', { sourceType: outcome.source.type });
      return;
    }
    await deliverOutcome(outcome, { ...deps, log: log.with({ attempt: outcome.attempt }) });
    return;
  }
  if (event['detail-type'] === PROGRESS_DETAIL_TYPE) {
    const errors = progressEventErrors(event.detail);
    if (errors.length > 0) {
      log.error('progress event ignored', { errors: errors.slice(0, 5) });
      return;
    }
    const progress = event.detail as ProgressEvent;
    if (!servesSource(progress.source.type)) {
      log.info('not a GitHub source', { sourceType: progress.source.type });
      return;
    }
    await noticeStarted(progress, { ...deps, log: log.with(progress.attempt !== undefined ? { attempt: progress.attempt } : {}) });
    return;
  }
  log.error('event ignored: unknown detail type', { detailType: String(event['detail-type']) });
}
