import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';

import type { Logger } from './log.ts';
import { asAgent, cleanRoomTarget, commandFor, sessionTarget, stopSession, stopSessionQuietly } from './session.ts';

const RUNTIME = 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/factorial_builder-abc';
const REVIEWER = 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/factorial_reviewer-abc';
const NAMES = ['REVIEWER_RUNTIME_ARN', 'RUNTIME_QUALIFIER', 'BUILDER_RUNTIME_ARN'];

describe('sessionTarget', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      REVIEWER_RUNTIME_ARN: REVIEWER,
      RUNTIME_QUALIFIER: 'live',
      BUILDER_RUNTIME_ARN: RUNTIME,
    });
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('targets the builder Runtime, clean room included', () => {
    assert.deepEqual(sessionTarget('s'), { arn: RUNTIME, qualifier: 'live', sessionId: 's' });
    assert.equal(cleanRoomTarget('w').arn, RUNTIME);
    assert.equal(cleanRoomTarget('w').sessionId, 'w-push');
  });

  it('targets the reviewer Runtime', () => {
    assert.deepEqual(sessionTarget('s', 'reviewer'), { arn: REVIEWER, qualifier: 'live', sessionId: 's' });
  });

  it('refuses a missing Runtime ARN', () => {
    delete process.env.BUILDER_RUNTIME_ARN;
    delete process.env.REVIEWER_RUNTIME_ARN;
    assert.throws(() => sessionTarget('s'), /BUILDER_RUNTIME_ARN/);
    assert.throws(() => sessionTarget('s', 'reviewer'), /REVIEWER_RUNTIME_ARN/);
  });
});

describe('asAgent', () => {
  it('drops to the agent user with the host wrapper’s restrictions on the Runtime', () => {
    const script = asAgent('echo ok');
    assert.match(script, /^exec setpriv --reuid=agent --regid=agent --init-groups --no-new-privs --bounding-set=-all -- \\\n/);
    assert.match(script, /env HOME=\/home\/agent bash -c 'echo ok'$/);
  });

  it('passes the inner script through intact, quotes and all', () => {
    const inner = `set -euo pipefail\nprintf '%s\\n' "it's" $HOME`;
    const wrapped = asAgent(inner);
    // Replace the privilege drop with a plain shell to check the quoting round-trips.
    const local = wrapped.replace(/^exec setpriv .*\\\n {2}env HOME=\/home\/agent /, 'env HOME=/home/agent ');
    assert.equal(execFileSync('bash', ['-c', local], { encoding: 'utf8' }), "it's\n/home/agent\n");
  });
});

describe('commandFor', () => {
  const script = `set -euo pipefail\nprintf '%s\\n' "it's" | cat\nexit 7`;

  it('names bash for the Runtime, which runs the first word as a program', () => {
    const command = commandFor(script);
    assert.match(command, /^bash -c '/);
    // A shell's word splitting, as the Runtime does, gives back the script intact.
    const run = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
    assert.equal(run.stdout, "it's\n");
    assert.equal(run.status, 7);
  });
});

describe('stopSession', () => {
  const target = { arn: RUNTIME, qualifier: 'live', sessionId: 'w-1' };
  afterEach(() => mock.restoreAll());

  it('stops the session with the Runtime, qualifier and session id of the commands', async () => {
    const send = mock.method(BedrockAgentCoreClient.prototype, 'send', async () => ({}));
    await stopSession(target);
    assert.equal(send.mock.callCount(), 1);
    const command = send.mock.calls[0]?.arguments[0] as StopRuntimeSessionCommand;
    assert.ok(command instanceof StopRuntimeSessionCommand);
    assert.deepEqual(command.input, { agentRuntimeArn: RUNTIME, qualifier: 'live', runtimeSessionId: 'w-1' });
  });

  it('treats a session that is not found as stopped', async () => {
    mock.method(BedrockAgentCoreClient.prototype, 'send', async () => {
      throw Object.assign(new Error('no such session'), { name: 'ResourceNotFoundException' });
    });
    await stopSession(target);
  });

  it('rethrows any other error', async () => {
    mock.method(BedrockAgentCoreClient.prototype, 'send', async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    await assert.rejects(stopSession(target), /denied/);
  });
});

describe('stopSessionQuietly', () => {
  const target = { arn: RUNTIME, qualifier: 'live', sessionId: 'w-1' };

  it('stops the session', async () => {
    const stopped: string[] = [];
    const log = { info: () => {}, error: () => assert.fail('nothing to log'), with: () => log } as Logger;
    await stopSessionQuietly(target, log, async (t) => void stopped.push(t.sessionId));
    assert.deepEqual(stopped, ['w-1']);
  });

  it('logs a failed stop with the session id and does not throw', async () => {
    const lines: Array<[string, unknown]> = [];
    const log = { info: () => {}, error: (message, fields) => lines.push([message, fields]), with: () => log } as Logger;
    await stopSessionQuietly(target, log, async () => {
      throw new Error('boom');
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.[0], 'session not stopped');
    assert.equal((lines[0]?.[1] as { sessionId: string }).sessionId, 'w-1');
  });
});
