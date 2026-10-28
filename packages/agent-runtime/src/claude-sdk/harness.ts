/**
 * The Claude Agent SDK as the host's harness: one `query()` per run, with the
 * role's policy as SDK hooks, streamed as run events (contracts/run/v1/).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RunEvent, RunStarted } from '@factorial/run';

import type { Config } from '../config.ts';
import type { Harness } from '../harness.ts';
import type { HostRole, Note } from '../roles.ts';
import type { RunRequest } from '../run.ts';
import { signedGatewayCall } from '../web-search.ts';
import { claudeRunEvents, runStarted } from './events.ts';
import { sdkHooks } from './hooks.ts';
import { queryOptions } from './options.ts';
import { CLAUDE_TOOLS } from './tools.ts';
import { webSearchServer } from './web-search.ts';

export function claudeHarness(config: Config, role: HostRole, abortController: AbortController): Harness {
  const started: RunStarted = runStarted(config, role.tools.map((kind) => CLAUDE_TOOLS[kind]));
  return {
    started,
    start(request: RunRequest, note: Note): AsyncIterable<RunEvent> {
      const policy = role.session(config.workspace, note, CLAUDE_TOOLS);
      const options = queryOptions(config, role, {
        hostEnv: process.env,
        ...sdkHooks(policy, note),
        webSearch:
          role.webSearch && config.webSearchGatewayUrl ? webSearchServer(signedGatewayCall(config.webSearchGatewayUrl, config.region)) : undefined,
        abortController,
        stderr: (data) => note('sdk stderr', { data: data.slice(0, 2000) }),
      });
      return claudeRunEvents(started, query({ prompt: policy.prompt(request.prompt), options }));
    },
  };
}
