import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { RecentIds, forward, noticeOf, workItemIdOfInput, type BusEvent } from './live-forward.ts';

const id = '0e418ab8-1603-4ef7-90e1-ca78a0330833';
const workItem = JSON.parse(readFileSync(new URL('../../../../contracts/workitem/v2/examples/github-issue.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const progress = JSON.parse(readFileSync(new URL('../../../../contracts/progress/v1/examples/stage-started.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const execution = (status: string, extra: Record<string, unknown> = {}): BusEvent => ({
  source: 'aws.states',
  'detail-type': 'Step Functions Execution Status Change',
  time: '2026-10-31T12:00:05Z',
  detail: {
    executionArn: 'arn:aws:states:eu-west-1:123456789012:execution:factorial-work:195cdea3_0e418ab8',
    stateMachineArn: 'arn:aws:states:eu-west-1:123456789012:stateMachine:factorial-work',
    name: '195cdea3-6511-3690-b013-e9ada58dd907_0e418ab8-1603-2ef7-10e1-ca78a0330833',
    status,
    startDate: Date.parse('2026-10-31T12:00:00Z'),
    stopDate: status === 'RUNNING' ? null : Date.parse('2026-10-31T12:30:00Z'),
    input: JSON.stringify({ ...workItem, id }),
    inputDetails: { included: true },
    output: '{"secret":"never forwarded"}',
    cause: 'never forwarded either',
    ...extra,
  },
});

const progressEvent: BusEvent = { source: 'factorial.progress', 'detail-type': 'WorkItemProgress', detail: progress };

describe('noticeOf', () => {
  it("takes an execution's work item from its input, not its name, and forwards nothing else of it", () => {
    assert.deepEqual(noticeOf(execution('RUNNING')), {
      workItemId: id,
      eventId: `${id}:Execution:started`,
      message: { eventId: `${id}:Execution:started`, workItemId: id, transition: 'started', at: '2026-10-31T12:00:00.000Z' },
    });
    const ended = noticeOf(execution('SUCCEEDED'));
    assert.ok('message' in ended);
    assert.deepEqual(ended.message, { eventId: `${id}:Execution:succeeded`, workItemId: id, transition: 'succeeded', at: '2026-10-31T12:30:00.000Z' });
  });

  it('maps every ending, and skips a redrive pending', () => {
    for (const [status, transition] of [
      ['FAILED', 'failed'],
      ['TIMED_OUT', 'timed-out'],
      ['ABORTED', 'aborted'],
    ]) {
      const notice = noticeOf(execution(status ?? ''));
      assert.ok('message' in notice);
      assert.equal(notice.message.transition, transition);
    }
    assert.deepEqual(noticeOf(execution('PENDING_REDRIVE')), { reason: 'status not forwarded', fields: { status: 'PENDING_REDRIVE' } });
  });

  it('skips an execution whose input was left out or holds no work item id', () => {
    const skipped = noticeOf(execution('RUNNING', { input: undefined, inputDetails: { included: false } }));
    assert.equal('reason' in skipped && skipped.reason, 'no work item id in the execution input');
    assert.equal(workItemIdOfInput('{"id":"not-a-uuid"}'), undefined);
    assert.equal(workItemIdOfInput('not json'), undefined);
  });

  it('forwards a progress event as it is, once it meets its contract', () => {
    const notice = noticeOf(progressEvent);
    assert.ok('message' in notice);
    assert.equal(notice.message, progress);
    assert.equal(notice.eventId, progress.eventId);
    const bad = noticeOf({ ...progressEvent, detail: { ...progress, transcript: 'content' } });
    assert.equal('reason' in bad && bad.reason, 'progress event does not meet its contract');
  });

  it('skips anything else', () => {
    assert.equal('reason' in noticeOf({ source: 'factorial.triggers', 'detail-type': 'WorkItem', detail: workItem }), true);
  });
});

describe('forward', () => {
  const log = { info: () => {} };

  it('publishes to every work item and to the one, and drops a repeat it has seen', async () => {
    const published: Array<[string, string[]]> = [];
    const deps = {
      publish: async (channel: string, events: string[]) => {
        published.push([channel, events]);
        return { failed: 0 };
      },
      recent: new RecentIds(),
      log,
    };
    assert.equal(await forward(execution('RUNNING'), deps), 'forwarded');
    assert.deepEqual(
      published.map(([channel]) => channel),
      ['/factorial/work-items', `/factorial/work-items/${id}`],
    );
    assert.deepEqual(JSON.parse(published[0]?.[1][0] ?? '{}'), { eventId: `${id}:Execution:started`, workItemId: id, transition: 'started', at: '2026-10-31T12:00:00.000Z' });
    assert.equal(await forward(execution('RUNNING'), deps), 'repeat');
    assert.equal(published.length, 2);
  });

  it('throws on a failed or refused publish, so Lambda retries, and forgets the id for the retry', async () => {
    const recent = new RecentIds();
    let fail = true;
    const deps = { publish: async () => ({ failed: fail ? 1 : 0 }), recent, log };
    await assert.rejects(forward(progressEvent, deps), /refused/);
    fail = false;
    assert.equal(await forward(progressEvent, deps), 'forwarded');
  });

  it('remembers a bounded number of ids', () => {
    const recent = new RecentIds(2);
    assert.equal(recent.add('a'), true);
    recent.add('b');
    recent.add('c');
    assert.equal(recent.add('a'), true);
    assert.equal(recent.add('c'), false);
  });
});
