import type { GitHubClient, TokenPermissions } from '@factorial/github-app';
import type { ProgressEvent } from '@factorial/progress';

import type { Logger } from '../lib/log.ts';
import type { NotifyLedger } from '../lib/notified.ts';

/** What a notifier needs from the world, so tests can stand in for it. */
export interface NotifierDeps {
  ledger: NotifyLedger;
  /** A client for the event's repository, with a token limited to these permissions. */
  github(repo: { owner: string; name: string }, permissions: TokenPermissions): Promise<Pick<GitHubClient, 'commentOnIssue' | 'addIssueReaction'>>;
  /** Carries the work item id. */
  log: Logger;
  now(): string;
}

/** Reacts to one progress event of one source type. It decides for itself whether the event is one it acts on. */
export type Notifier = (event: ProgressEvent, deps: NotifierDeps) => Promise<void>;
