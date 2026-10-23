import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { HOST_ERROR, MAX_DURATION, Run, type Entry } from './run.ts';

const result = { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01 };

/** A query that yields the given messages, each after the previous is released. */
function gated(messages: unknown[]) {
  const releases: (() => void)[] = [];
  const gates = messages.map(() => new Promise<void>((resolve) => releases.push(resolve)));
  async function* iterate() {
    for (const [index, message] of messages.entries()) {
      await gates[index];
      yield message;
    }
  }
  return { iterate, release: (index: number) => releases[index]?.() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-runtime-'));
}

describe('Run', () => {
  it('records every message, the result and the outcome', async () => {
    const dir = directory();
    const states: string[] = [];
    const run = new Run(dir, async function* () {
      yield { type: 'system', subtype: 'init' };
      yield result;
    }, (state) => states.push(state));

    assert.equal(run.start({ prompt: 'go', round: 1 }), true);
    await tick();
    await tick();

    assert.deepEqual(states, ['running', 'finished']);
    const status = run.status();
    assert.equal(status.outcome, 'complete');
    assert.equal(status.messages, 2);
    const lines = readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Entry);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2]);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).outcome, 'complete');
  });

  it('allows one run per session', async () => {
    const run = new Run(directory(), async function* () {
      yield result;
    });
    assert.equal(run.start({ prompt: 'go', round: 1 }), true);
    assert.equal(run.start({ prompt: 'again', round: 1 }), false);
    await tick();
    assert.equal(run.start({ prompt: 'after', round: 2 }), false);
  });

  it('replays from the transcript and continues live without gaps or repeats', async () => {
    const query = gated([{ n: 1 }, { n: 2 }, { n: 3 }, result]);
    const run = new Run(directory(), query.iterate);
    run.start({ prompt: 'go', round: 1 });
    query.release(0);
    query.release(1);
    await tick();

    const seen: number[] = [];
    let ended = false;
    run.subscribe(1, (entry) => seen.push(entry.seq), () => (ended = true));
    assert.deepEqual(seen, [2]);

    query.release(2);
    query.release(3);
    await tick();
    await tick();
    assert.deepEqual(seen, [2, 3, 4]);
    assert.equal(ended, true);
  });

  it('ends a subscription at once when the run is over', async () => {
    const run = new Run(directory(), async function* () {
      yield result;
    });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    const seen: number[] = [];
    let ended = false;
    run.subscribe(0, (entry) => seen.push(entry.seq), () => (ended = true));
    assert.deepEqual(seen, [1]);
    assert.equal(ended, true);
  });

  it('fails the run when the SDK throws or ends without a result', async () => {
    const thrown = new Run(directory(), async function* () {
      yield { type: 'system' };
      throw new Error('subprocess exited');
    });
    thrown.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(thrown.status().state, 'failed');
    assert.equal(thrown.status().error, 'subprocess exited');

    const silent = new Run(directory(), async function* () {
      yield { type: 'system' };
    });
    silent.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(silent.status().state, 'failed');
    const last: unknown[] = [];
    silent.subscribe(1, (entry) => last.push(entry.message), () => {});
    assert.deepEqual(last, [{ type: HOST_ERROR, error: 'the SDK ended without a result message' }]);
  });
});

describe('Run time limit', () => {
  it('stops the run at its limit and reports it as incomplete', async () => {
    let aborted = false;
    let release: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (release = resolve));
    const run = new Run(
      directory(),
      async function* () {
        yield { type: 'system', subtype: 'init' };
        await stopped;
        throw new Error('aborted');
      },
      () => {},
      {
        maxDurationMs: 5,
        abort: () => {
          aborted = true;
          release();
        },
      },
    );
    run.start({ prompt: 'go', round: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(aborted, true);
    const status = run.status();
    assert.equal(status.state, 'finished');
    assert.equal(status.outcome, 'incomplete');
    assert.equal(status.stopReason, 'max_duration');
    const last: unknown[] = [];
    run.subscribe(1, (entry) => last.push(entry.message), () => {});
    assert.deepEqual(last, [{ type: MAX_DURATION }]);
  });

  it('keeps a success that arrives before the limit', async () => {
    const run = new Run(directory(), async function* () {
      yield result;
    }, () => {}, { maxDurationMs: 60_000, abort: () => assert.fail('aborted') });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(run.status().outcome, 'complete');
    assert.equal(run.status().stopReason, undefined);
  });
});
