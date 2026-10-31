import type { GitHubClient, TokenPermissions } from '@factorial/github-app';

import type { DeliveryLedger } from '../../lib/delivery-ledger.ts';
import type { Logger } from '../../lib/log.ts';
import type { NotifyLedger } from '../../lib/notified.ts';

/** The GitHub calls the reporter makes. */
export type ReporterClient = Pick<GitHubClient, 'commentOnIssue' | 'addIssueReaction' | 'requestReviewers' | 'listIssueComments'>;

/** What the GitHub reporter needs from the world, so tests can stand in for it. */
export interface ReporterDeps {
  /** The started notice's guard. */
  ledger: NotifyLedger;
  /** The outcome delivery's guard. */
  deliveries: DeliveryLedger;
  /** A client for the event's repository, with a token limited to these permissions. */
  github(repo: { owner: string; name: string }, permissions: TokenPermissions): Promise<ReporterClient>;
  /** The attempt's `report.json`, at most a capped size; undefined when there is none. */
  readReport(prefix: string): Promise<string | undefined>;
  /** The App's bot login, the author of every comment it posts. */
  botLogin(): Promise<string>;
  /** Carries the work item id. */
  log: Logger;
  now(): Date;
}
