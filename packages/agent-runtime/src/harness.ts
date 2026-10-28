/**
 * What the host needs from a harness: its run.started event, and a run's
 * events (contracts/run/v1/) for a request. The role's definition, policy and
 * limits are the host's (roles.ts, config.ts); the harness maps them onto its
 * own API. The Claude Agent SDK's is claude-sdk/harness.ts.
 */
import type { RunEvent, RunStarted } from '@factorial/run';

import type { Note } from './roles.ts';
import type { RunRequest } from './run.ts';

export interface Harness {
  started: RunStarted;
  start(request: RunRequest, note: Note): AsyncIterable<RunEvent>;
}
