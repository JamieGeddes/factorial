import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { validateRunEvent, validateRunStatus, type RunEnded, type RunEvent } from '@factorial/run';

import { Run, type Entry } from './run.ts';

const started: RunEvent = {
  type: 'run.started',
  contract: 1,
  harness: { name: 'test-harness' },
  role: 'builder',
  models: [{ purpose: 'main', provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' }],
};
const text = (n: number): RunEvent => ({ type: 'text', text: `step ${n}` });
const completed: RunEnded = { type: 'run.ended', outcome: 'complete', reason: 'completed', detail: 'success', turns: 2, cost: { usd: 0.01, basis: 'harness-estimate' } };

/** A source that yields the given events, each after the previous is released. */
function gated(events: RunEvent[]) {
  const releases: (() => void)[] = [];
  const gates = events.map(() => new Promise<void>((resolve) => releases.push(resolve)));
  async function* iterate() {
    for (const [index, event] of events.entries()) {
      await gates[index];
      yield event;
    }
  }
  return { iterate, release: (index: number) => releases[index]?.() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-runtime-'));
}

function recorded(run: Run): RunEvent[] {
  const events: RunEvent[] = [];
  run.subscribe(0, (entry) => events.push(entry.event), () => {});
  return events;
}

describe('Run', () => {
  it('records every event and ends with one run.ended, in the contract', async () => {
    const dir = directory();
    const states: string[] = [];
    const run = new Run(dir, async function* () {
      yield started;
      yield text(1);
      yield completed;
    }, (state) => states.push(state));

    assert.equal(run.start({ prompt: 'go', round: 1 }), true);
    await tick();
    await tick();

    assert.deepEqual(states, ['running', 'finished']);
    const status = run.status();
    assert.deepEqual(status, { contract: 1, state: 'finished', events: 3, ended: completed });
    assert.ok(validateRunStatus(status).ok);
    const lines = readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Entry);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
    for (const line of lines) assert.ok(validateRunEvent(line.event).ok);
    assert.equal(lines.at(-1)?.event.type, 'run.ended');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).ended.outcome, 'complete');
  });

  it("keeps run.ended last when the harness sends events after its own", async () => {
    const run = new Run(directory(), async function* () {
      yield started;
      yield completed;
      yield { type: 'harness', name: 'test-harness', message: { type: 'system', subtype: 'status' } };
    });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.deepEqual(recorded(run).map((event) => event.type), ['run.started', 'harness', 'run.ended']);
  });

  it('allows one run per session', async () => {
    const run = new Run(directory(), async function* () {
      yield completed;
    });
    assert.equal(run.start({ prompt: 'go', round: 1 }), true);
    assert.equal(run.start({ prompt: 'again', round: 1 }), false);
    await tick();
    assert.equal(run.start({ prompt: 'after', round: 2 }), false);
  });

  it('replays from the transcript and continues live without gaps or repeats', async () => {
    const source = gated([started, text(1), text(2), completed]);
    const run = new Run(directory(), source.iterate);
    run.start({ prompt: 'go', round: 1 });
    source.release(0);
    source.release(1);
    await tick();

    const seen: number[] = [];
    let ended = false;
    run.subscribe(1, (entry) => seen.push(entry.seq), () => (ended = true));
    assert.deepEqual(seen, [2]);

    source.release(2);
    source.release(3);
    await tick();
    await tick();
    assert.deepEqual(seen, [2, 3, 4]);
    assert.equal(ended, true);
  });

  it('ends a subscription at once when the run is over', async () => {
    const run = new Run(directory(), async function* () {
      yield completed;
    });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    const seen: number[] = [];
    let ended = false;
    run.subscribe(0, (entry) => seen.push(entry.seq), () => (ended = true));
    assert.deepEqual(seen, [1]);
    assert.equal(ended, true);
  });

  it('fails the run as a host error when the harness throws or ends without a result', async () => {
    const thrown = new Run(directory(), async function* () {
      yield started;
      throw new Error('subprocess exited');
    });
    thrown.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(thrown.status().state, 'failed');
    assert.deepEqual(thrown.status().ended, { type: 'run.ended', outcome: 'failed', reason: 'host_error', errors: ['subprocess exited'] });

    const silent = new Run(directory(), async function* () {
      yield started;
    });
    silent.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(silent.status().state, 'failed');
    assert.deepEqual(recorded(silent).at(-1), { type: 'run.ended', outcome: 'failed', reason: 'host_error', errors: ['the harness ended without a result'] });
  });
});

describe('Run after an error result', () => {
  it('lets the result decide when the harness throws after it', async () => {
    const limited: RunEnded = { type: 'run.ended', outcome: 'incomplete', reason: 'max_turns', detail: 'error_max_turns', turns: 4 };
    const run = new Run(directory(), async function* () {
      yield started;
      yield limited;
      throw new Error('Claude Code returned an error result: Reached maximum number of turns (3)');
    });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    const status = run.status();
    assert.equal(status.state, 'finished');
    assert.deepEqual(status.ended, limited);
    assert.deepEqual(recorded(run).map((event) => event.type), ['run.started', 'run.ended']);
  });

  it('still fails when the harness throws after a success, keeping what it reported', async () => {
    const run = new Run(directory(), async function* () {
      yield completed;
      throw new Error('late failure');
    });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.equal(run.status().state, 'failed');
    assert.deepEqual(run.status().ended, {
      type: 'run.ended',
      outcome: 'failed',
      reason: 'host_error',
      errors: ['late failure'],
      turns: 2,
      cost: { usd: 0.01, basis: 'harness-estimate' },
    });
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
        yield started;
        await stopped;
        yield { type: 'run.ended', outcome: 'failed', reason: 'harness_error', detail: 'error_during_execution', turns: 7 } satisfies RunEnded;
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
    assert.deepEqual(status.ended, { type: 'run.ended', outcome: 'incomplete', reason: 'max_duration', detail: 'error_during_execution', turns: 7 });
  });

  it('keeps a success that arrives before the limit', async () => {
    const run = new Run(directory(), async function* () {
      yield completed;
    }, () => {}, { maxDurationMs: 60_000, abort: () => assert.fail('aborted') });
    run.start({ prompt: 'go', round: 1 });
    await tick();
    await tick();
    assert.deepEqual(run.status().ended, completed);
  });
});
