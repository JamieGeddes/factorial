import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { asAgent, cleanRoomTarget, commandFor, sessionTarget } from './session.ts';

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
