import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Run } from './run.ts';
import { createServer, parseInvocation, pingTracker } from './server.ts';

const result = { type: 'result', subtype: 'success' };

function events(text: string): { id: number; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const id = Number(/^id: (\d+)$/m.exec(block)?.[1]);
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
      return { id, data };
    });
}

describe('parseInvocation', () => {
  it('accepts the three actions', () => {
    assert.deepEqual(parseInvocation({ action: 'run', prompt: 'go', round: 1, workItemId: 'w', attempt: 2 }), {
      action: 'run',
      request: { prompt: 'go', round: 1, workItemId: 'w', attempt: 2 },
    });
    assert.deepEqual(parseInvocation({ action: 'attach' }), { action: 'attach', after: 0 });
    assert.deepEqual(parseInvocation({ action: 'attach', after: 7 }), { action: 'attach', after: 7 });
    assert.deepEqual(parseInvocation({ action: 'status' }), { action: 'status' });
  });

  it('rejects anything else', () => {
    assert.equal(typeof parseInvocation({ action: 'run', prompt: ' ', round: 1 }), 'string');
    assert.equal(typeof parseInvocation({ action: 'run', prompt: 'go', round: 0 }), 'string');
    assert.equal(typeof parseInvocation({ action: 'attach', after: -1 }), 'string');
    assert.equal(typeof parseInvocation({ action: 'deploy' }), 'string');
    assert.equal(typeof parseInvocation(null), 'string');
  });

  it('ignores a model or other settings in the request', () => {
    const parsed = parseInvocation({ action: 'run', prompt: 'go', round: 1, model: 'other', maxTurns: 9999 });
    assert.deepEqual(parsed, { action: 'run', request: { prompt: 'go', round: 1, workItemId: undefined, attempt: undefined } });
  });
});

describe('pingTracker', () => {
  it('changes time_of_last_update only when the status changes', () => {
    let now = 100;
    const tracker = pingTracker(() => now);
    assert.deepEqual(tracker.ping(), { status: 'Healthy', time_of_last_update: 100 });
    now = 200;
    tracker.setBusy(true);
    assert.deepEqual(tracker.ping(), { status: 'HealthyBusy', time_of_last_update: 200 });
    now = 300;
    tracker.setBusy(true);
    assert.equal(tracker.ping().time_of_last_update, 200);
    tracker.setBusy(false);
    assert.deepEqual(tracker.ping(), { status: 'Healthy', time_of_last_update: 300 });
  });
});

describe('createServer', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tracker = pingTracker(() => 1);
  const run = new Run(mkdtempSync(path.join(tmpdir(), 'agent-runtime-')), async function* () {
    yield { type: 'system', subtype: 'init' };
    await gate;
    yield result;
  }, (state) => tracker.setBusy(state === 'running'));
  const server = createServer(run, tracker.ping);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => server.close());

  const invoke = (body: unknown) =>
    fetch(`${base}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reports Healthy, then HealthyBusy during a run, and streams the run', async () => {
    assert.equal(((await (await fetch(`${base}/ping`)).json()) as { status: string }).status, 'Healthy');
    assert.equal((await invoke({ action: 'attach' })).status, 409);

    const response = await invoke({ action: 'run', prompt: 'go', round: 1 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const body = response.text();

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(((await (await fetch(`${base}/ping`)).json()) as { status: string }).status, 'HealthyBusy');
    assert.equal((await invoke({ action: 'run', prompt: 'again', round: 1 })).status, 409);

    release();
    assert.deepEqual(events(await body), [
      { id: 1, data: { type: 'system', subtype: 'init' } },
      { id: 2, data: result },
    ]);
    assert.equal(((await (await fetch(`${base}/ping`)).json()) as { status: string }).status, 'Healthy');
  });

  it('replays after a given message on attach, and reports status', async () => {
    assert.deepEqual(events(await (await invoke({ action: 'attach', after: 1 })).text()), [{ id: 2, data: result }]);
    const status = (await (await invoke({ action: 'status' })).json()) as { state: string; outcome: string };
    assert.equal(status.state, 'finished');
    assert.equal(status.outcome, 'complete');
  });

  it('rejects bad requests and unknown paths', async () => {
    assert.equal((await invoke({ action: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/invocations`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
});
