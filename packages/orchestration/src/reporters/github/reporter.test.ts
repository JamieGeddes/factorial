import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createLogger } from '@factorial/log';
import type { Outcome } from '@factorial/outcome';
import type { ProgressEvent } from '@factorial/progress';

import { DELIVERY_LEASE_MS, MemoryDeliveryLedger } from '../../lib/delivery-ledger.ts';
import { MemoryNotifyLedger } from '../../lib/notified.ts';
import type { ReportFile, ReworkReplyFacts } from '../../lib/report-file.ts';
import { commentTarget, outcomeMarker, planDelivery } from './deliver.ts';
import { handleEvent, type ReporterDeps } from './index.ts';
import { issueNumberFromUrl, startedComment } from './started.ts';
import type { ReporterClient } from './types.ts';

const repository = { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } as const;
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const issueUrl = 'https://github.com/JamieGeddes/factorial/issues/205';
const BOT = 'factorial-bot[bot]';
const T0 = new Date('2026-10-31T12:00:00.000Z');

const examples = new URL('../../../../../contracts/outcome/v1/examples/', import.meta.url);
const example = (name: string): Outcome => JSON.parse(readFileSync(new URL(name, examples), 'utf8')) as Outcome;

function progress(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    schemaVersion: 1,
    eventId: `${ID}:Build:started`,
    workItemId: ID,
    attempt: 1,
    source: { type: 'github-issue', url: issueUrl },
    repository,
    stage: 'Build',
    transition: 'started',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const progressEvent = (detail: unknown) => ({ 'detail-type': 'WorkItemProgress', detail });
const outcomeEvent = (detail: unknown) => ({ 'detail-type': 'Outcome', detail });

interface Harness {
  deps: ReporterDeps;
  calls: string[];
  logs: string[];
  ledger: MemoryNotifyLedger;
  deliveries: MemoryDeliveryLedger;
  /** Comments already on each target, as listIssueComments returns them. */
  existing: Map<number, Array<{ authorLogin: string; body: string }>>;
  reports: Map<string, string>;
  clock: { now: Date };
}

interface HarnessOptions {
  ledger?: MemoryNotifyLedger;
  deliveries?: MemoryDeliveryLedger;
  failComment?: number;
  failReaction?: boolean;
  failReviewers?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const ledger = options.ledger ?? new MemoryNotifyLedger();
  const deliveries = options.deliveries ?? new MemoryDeliveryLedger();
  const existing = new Map<number, Array<{ authorLogin: string; body: string }>>();
  const reports = new Map<string, string>();
  const clock = { now: T0 };
  let commentFailures = options.failComment ?? 0;
  const client: ReporterClient = {
    addIssueReaction: async (r, number, content) => {
      if (options.failReaction) throw new Error('reaction refused');
      calls.push(`react ${r.owner}/${r.name}#${number} ${content}`);
    },
    commentOnIssue: async (r, number, body) => {
      if (commentFailures > 0) {
        commentFailures -= 1;
        throw new Error('comment refused');
      }
      calls.push(`comment ${r.owner}/${r.name}#${number} ${body}`);
      existing.set(number, [...(existing.get(number) ?? []), { authorLogin: BOT, body }]);
    },
    requestReviewers: async (r, number, reviewers) => {
      if (options.failReviewers) throw new Error('reviewer refused');
      calls.push(`reviewers ${r.owner}/${r.name}#${number} ${reviewers.join(',')}`);
    },
    listIssueComments: async (_r, number) => {
      calls.push(`list #${number}`);
      return existing.get(number) ?? [];
    },
  };
  const deps: ReporterDeps = {
    ledger,
    deliveries,
    log: createLogger('report-github', {}, (line) => logs.push(line)),
    now: () => clock.now,
    github: async (repo, permissions) => {
      calls.push(`token ${repo.owner}/${repo.name} ${JSON.stringify(permissions)}`);
      return client;
    },
    readReport: async (prefix) => reports.get(prefix),
    botLogin: async () => BOT,
  };
  return { deps, calls, logs, ledger, deliveries, existing, reports, clock };
}

const comments = (h: Harness): string[] => h.calls.filter((c) => c.startsWith('comment'));

describe('routing', () => {
  it('ignores an event of another detail type', async () => {
    const h = harness();
    await handleEvent({ 'detail-type': 'WorkItem', detail: { workItemId: ID } }, h.deps);
    assert.deepEqual(h.calls, []);
    assert.match(h.logs.join('\n'), /unknown detail type/);
  });

  it('ignores a progress event from a source it does not serve', async () => {
    const h = harness();
    await handleEvent(progressEvent(progress({ source: { type: 'jira-issue', url: 'https://example.atlassian.net/browse/X-1' } })), h.deps);
    assert.deepEqual(h.calls, []);
    assert.equal(h.ledger.claimed.size, 0);
    assert.match(h.logs.join('\n'), /not a GitHub source/);
  });

  it('ignores an outcome from a source it does not serve', async () => {
    const h = harness();
    const outcome = { ...example('pr-opened.json'), source: { type: 'jira-issue', id: 'X-1', url: 'https://example.atlassian.net/browse/X-1' } };
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.deepEqual(h.calls, []);
    assert.equal(h.deliveries.records.size, 0);
  });

  it('ignores events that fail their schema', async () => {
    const h = harness();
    await handleEvent(progressEvent({ ...progress(), unexpected: true }), h.deps);
    await handleEvent(progressEvent('nonsense'), h.deps);
    await handleEvent(outcomeEvent({ ...example('pr-opened.json'), body: 'content' }), h.deps);
    assert.deepEqual(h.calls, []);
    assert.match(h.logs.join('\n'), /progress event ignored/);
    assert.match(h.logs.join('\n'), /outcome ignored/);
  });

  it('logs lines with the work item id', async () => {
    const h = harness();
    await handleEvent(progressEvent(progress({ source: { type: 'jira-issue', url: 'https://example.com/x' } })), h.deps);
    assert.equal(JSON.parse(h.logs[0] ?? '{}').workItemId, ID);
  });
});

describe('the started notice: which events it acts on', () => {
  it('reacts and comments on the start of Build with no round', async () => {
    const h = harness();
    await handleEvent(progressEvent(progress()), h.deps);
    assert.deepEqual(h.calls, [
      'token JamieGeddes/factorial {"issues":"write"}',
      'react JamieGeddes/factorial#205 eyes',
      `comment JamieGeddes/factorial#205 ${startedComment(ID)}`,
    ]);
  });

  it('gives a rework turn nothing: Intake already reacts', async () => {
    for (const type of ['github-pull-request', 'github-pull-request-review', 'github-pull-request-review-comment', 'github-pull-request-comment']) {
      const h = harness();
      await handleEvent(progressEvent(progress({ source: { type, url: 'https://github.com/JamieGeddes/factorial/pull/9#issuecomment-1' } })), h.deps);
      assert.deepEqual(h.calls, [], type);
      assert.equal(h.ledger.claimed.size, 0, type);
    }
  });

  const ignored: Array<[string, Partial<ProgressEvent>]> = [
    ['a later round of Build', { eventId: `${ID}:Build#2:started`, round: 2 }],
    ['the end of Build', { transition: 'succeeded' }],
    ['a failed Build', { transition: 'failed' }],
    ['ContinueBuild', { stage: 'ContinueBuild', round: 2 }],
    ['the start of Intake', { stage: 'Intake' }],
    ['the start of Review', { stage: 'Review' }],
    ['the end of the work item', { stage: 'WorkItem', transition: 'ended', status: 'pr-opened' }],
  ];
  for (const [name, overrides] of ignored) {
    it(`does nothing on ${name}`, async () => {
      const h = harness();
      await handleEvent(progressEvent(progress(overrides)), h.deps);
      assert.deepEqual(h.calls, []);
      assert.equal(h.ledger.claimed.size, 0);
    });
  }
});

describe('the started notice: idempotency', () => {
  it('posts nothing for a replayed event', async () => {
    const h = harness();
    await handleEvent(progressEvent(progress()), h.deps);
    await handleEvent(progressEvent(progress()), h.deps);
    assert.equal(comments(h).length, 1);
  });

  it('posts nothing when the work item has no ledger row', async () => {
    const h = harness({ ledger: new MemoryNotifyLedger([ID2]) });
    await handleEvent(progressEvent(progress()), h.deps);
    assert.deepEqual(h.calls, []);
  });

  it('releases the claim when the comment fails, so a redelivery posts it', async () => {
    const h = harness({ failComment: 1 });
    await assert.rejects(handleEvent(progressEvent(progress()), h.deps), /comment refused/);
    assert.equal(h.ledger.claimed.size, 0);
    await handleEvent(progressEvent(progress()), h.deps);
    assert.equal(comments(h).length, 1);
  });

  it('still posts the comment when the reaction fails', async () => {
    const h = harness({ failReaction: true });
    await handleEvent(progressEvent(progress()), h.deps);
    assert.equal(comments(h).length, 1);
    assert.match(h.logs.join('\n'), /reaction failed/);
  });
});

describe('the issue number', () => {
  it('reads it from an issue URL in the event repository', () => {
    assert.equal(issueNumberFromUrl(issueUrl, repository), 205);
    assert.equal(issueNumberFromUrl('https://github.com/jamiegeddes/FACTORIAL/issues/7', repository), 7);
  });

  it('refuses any other shape', () => {
    for (const url of [
      'https://github.com/JamieGeddes/other/issues/205',
      'https://github.com/JamieGeddes/factorial/pull/205',
      'https://github.com/JamieGeddes/factorial/issues/0',
      'https://github.com/JamieGeddes/factorial/issues/205#issuecomment-1',
      'http://github.com/JamieGeddes/factorial/issues/205',
      '',
    ]) {
      assert.equal(issueNumberFromUrl(url, repository), undefined, url);
    }
  });
});

describe('where an outcome is told', () => {
  it('on the pull request a turn continued, otherwise on the source issue', () => {
    assert.equal(commentTarget(example('pr-updated.json')), 230);
    assert.equal(commentTarget(example('refused.json')), 230);
    assert.equal(commentTarget(example('pr-opened.json')), 165);
  });

  it('nowhere for a source that is neither', () => {
    const { inReplyTo: _i, ...outcome } = { ...example('refused.json'), source: { type: 'github-push', id: 'd', url: 'https://github.com/JamieGeddes/factorial' } };
    assert.equal(commentTarget(outcome), undefined);
  });
});

const reportFile = (delivery: NonNullable<ReportFile['delivery']>): string => {
  const file: ReportFile = { outcome: 'x', reason: 'y', delivery };
  return JSON.stringify(file);
};

const reply: ReworkReplyFacts = {
  cause: 'review',
  requestedBy: 'alice',
  headSha: '9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
  test: { runUrl: 'https://x/run/1', outcome: 'success' },
  points: [{ author: 'alice', path: 'src/a.ts', line: 3 }, { author: 'bob' }],
  summaryText: '## Summary\nRenamed it.\n\n## Rework points\n- 1: Renamed it. @everyone\n- 2: Added a test.\n',
  runDetails: {
    source: { type: 'github-pull-request-review', id: 'a1', url: 'https://github.com/JamieGeddes/factorial/pull/230#pullrequestreview-1' },
    requestedBy: 'alice',
    branch: 'factorial/0b8f4a52-5d3c-4c2e-9a51-2f6d1e7c8a90',
    factorialVersion: '0123456789abcdef0123456789abcdef01234567',
    sessionId: '7c1d9e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
    artefactPrefix: '7c1d9e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f/1/',
  },
};

describe('delivering an outcome', () => {
  it('tells the issue its pull request is open, with the marker', async () => {
    const h = harness();
    const outcome = example('pr-opened.json');
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.deepEqual(h.calls, [
      'token JamieGeddes/factorial {"issues":"write"}',
      `comment JamieGeddes/factorial#165 Factorial has opened https://github.com/JamieGeddes/factorial/pull/230 for review.\n\n${outcomeMarker(outcome.workItemId)}\n`,
    ]);
    assert.ok(h.deliveries.records.get(outcome.workItemId)?.deliveredAt);
  });

  it('replies on the reworked pull request and re-requests review', async () => {
    const h = harness();
    const outcome = example('pr-updated.json');
    h.reports.set(outcome.artefactPrefix, reportFile({ kind: 'rework-reply', reply, reviewers: ['alice', 'bob'] }));
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.equal(h.calls[0], 'token JamieGeddes/factorial {"issues":"write","pull_requests":"write"}');
    const [comment] = comments(h);
    assert.match(comment ?? '', /^comment JamieGeddes\/factorial#230 Factorial has reworked this pull request after the review/);
    assert.match(comment ?? '', /1\. @alice on `src\/a\.ts:3`: Renamed it\. @​everyone/);
    assert.equal(h.calls.at(-1), 'reviewers JamieGeddes/factorial#230 alice,bob');
  });

  it('still confirms the reply when the review re-request is refused', async () => {
    const h = harness({ failReviewers: true });
    const outcome = example('pr-updated.json');
    h.reports.set(outcome.artefactPrefix, reportFile({ kind: 'rework-reply', reply, reviewers: ['alice'] }));
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.equal(comments(h).length, 1);
    assert.ok(h.deliveries.records.get(outcome.workItemId)?.deliveredAt);
    assert.match(h.logs.join('\n'), /review not re-requested/);
  });

  it('answers a refusal on the pull request only when a reply is due', async () => {
    const outcome = example('refused.json');
    const due = harness();
    due.reports.set(outcome.artefactPrefix, reportFile({ kind: 'refusal', reply: 'Factorial is already working on this pull request.' }));
    await handleEvent(outcomeEvent(outcome), due.deps);
    assert.match(comments(due)[0] ?? '', /^comment JamieGeddes\/factorial#230 Factorial is already working/);

    const silent = harness();
    silent.reports.set(outcome.artefactPrefix, reportFile({ kind: 'refusal' }));
    await handleEvent(outcomeEvent(outcome), silent.deps);
    assert.deepEqual(silent.calls, []);
    assert.equal(silent.deliveries.records.size, 0);
  });

  it('reports a failed build on the issue with the saved branch', async () => {
    const h = harness();
    const outcome = example('failed-saved-work.json');
    h.reports.set(
      outcome.artefactPrefix,
      reportFile({ kind: 'report', facts: { status: 'failed', rework: false, sessionId: 's1', incomplete: true, buildRound: 3, savedWork: { branch: 'factorial/x', commits: 3 } } }),
    );
    await handleEvent(outcomeEvent(outcome), h.deps);
    const [comment] = comments(h);
    assert.match(comment ?? '', /^comment JamieGeddes\/factorial#165 Factorial's builder reached its iteration or time limit in 3 sessions/);
    assert.match(comment ?? '', /\(3 commits\) was saved to \[`factorial\/x`\]\(https:\/\/github\.com\/JamieGeddes\/factorial\/tree\/factorial\/x\)/);
  });

  it('caps what the agent said and stops it mentioning anyone', () => {
    const { savedWork: _saved, ...rest } = example('failed-saved-work.json');
    const outcome: Outcome = { ...rest, result: 'no-changes' };
    const plan = planDelivery(outcome, { kind: 'report', facts: { status: 'no-changes', rework: false, agentSaid: `@someone ${'word '.repeat(2000)}` } });
    assert.ok(plan);
    assert.match(plan.body, /@​someone/);
    assert.ok(plan.body.length < 4500);
  });

  it('refuses a report that does not match the outcome, or none at all', async () => {
    const outcome = example('pr-updated.json');
    const missing = harness();
    await assert.rejects(handleEvent(outcomeEvent(outcome), missing.deps), /no report\.json/);
    const wrong = harness();
    wrong.reports.set(outcome.artefactPrefix, reportFile({ kind: 'refusal' }));
    await assert.rejects(handleEvent(outcomeEvent(outcome), wrong.deps), /not rework-reply/);
    const malformed = harness();
    malformed.reports.set(outcome.artefactPrefix, '{"outcome":"x","reason":"y","delivery":{"kind":"report","facts":{"status":"failed"}}}');
    await assert.rejects(handleEvent(outcomeEvent(outcome), malformed.deps), /facts\.rework/);
    assert.deepEqual([...missing.calls, ...wrong.calls, ...malformed.calls], []);
  });
});

describe('delivering an outcome once', () => {
  it('posts nothing for a redelivered event', async () => {
    const h = harness();
    await handleEvent(outcomeEvent(example('pr-opened.json')), h.deps);
    await handleEvent(outcomeEvent(example('pr-opened.json')), h.deps);
    assert.equal(comments(h).length, 1);
  });

  it('posts nothing when the work item has no ledger row', async () => {
    const h = harness({ deliveries: new MemoryDeliveryLedger([ID2]) });
    await handleEvent(outcomeEvent(example('pr-opened.json')), h.deps);
    assert.deepEqual(h.calls, []);
  });

  it('releases the claim when the comment fails, so the retry posts it after checking for the marker', async () => {
    const h = harness({ failComment: 1 });
    const outcome = example('pr-opened.json');
    await assert.rejects(handleEvent(outcomeEvent(outcome), h.deps), /comment refused/);
    assert.equal(h.deliveries.records.get(outcome.workItemId)?.released, true);
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.ok(h.calls.includes('list #165'));
    assert.equal(comments(h).length, 1);
    assert.ok(h.deliveries.records.get(outcome.workItemId)?.deliveredAt);
  });

  it('defers to a live claim, so Lambda retries', async () => {
    const outcome = example('pr-opened.json');
    const deliveries = new MemoryDeliveryLedger();
    deliveries.records.set(outcome.workItemId, { claimedAt: T0.toISOString() });
    const h = harness({ deliveries });
    h.clock.now = new Date(T0.getTime() + 30_000);
    await assert.rejects(handleEvent(outcomeEvent(outcome), h.deps), /another attempt is delivering/);
    assert.deepEqual(h.calls, []);
  });

  it('takes over a lapsed claim and does not post again when the comment is there', async () => {
    const outcome = example('pr-opened.json');
    const deliveries = new MemoryDeliveryLedger();
    deliveries.records.set(outcome.workItemId, { claimedAt: T0.toISOString() });
    const h = harness({ deliveries });
    h.existing.set(165, [
      { authorLogin: 'mallory', body: outcomeMarker(outcome.workItemId) },
      { authorLogin: BOT, body: `Factorial has opened it.\n\n${outcomeMarker(outcome.workItemId)}\n` },
    ]);
    h.clock.now = new Date(T0.getTime() + DELIVERY_LEASE_MS + 1);
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.deepEqual(comments(h), []);
    assert.ok(h.deliveries.records.get(outcome.workItemId)?.deliveredAt);
  });

  it('posts on takeover when only someone else carries the marker', async () => {
    const outcome = example('pr-opened.json');
    const deliveries = new MemoryDeliveryLedger();
    deliveries.records.set(outcome.workItemId, { claimedAt: T0.toISOString(), released: true });
    const h = harness({ deliveries });
    h.existing.set(165, [{ authorLogin: 'mallory', body: outcomeMarker(outcome.workItemId) }]);
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.equal(comments(h).length, 1);
  });

  it('never claims for an outcome that needs no comment', async () => {
    const h = harness();
    const { inReplyTo: _i, ...outcome } = { ...example('refused.json'), source: { type: 'github-push', id: 'd', url: 'https://github.com/JamieGeddes/factorial' } };
    await handleEvent(outcomeEvent(outcome), h.deps);
    assert.equal(h.deliveries.records.size, 0);
    assert.match(h.logs.join('\n'), /needs no comment/);
  });
});
