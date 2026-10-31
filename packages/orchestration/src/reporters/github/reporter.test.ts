import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '@factorial/log';
import type { ProgressEvent } from '@factorial/progress';

import { MemoryNotifyLedger } from '../lib/notified.ts';
import { issueNumberFromUrl, startedComment } from './github-issue.ts';
import { handleProgress, type NotifierDeps } from './index.ts';

const repository = { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } as const;
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const issueUrl = 'https://github.com/JamieGeddes/factorial/issues/205';

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
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

interface Harness {
  deps: NotifierDeps;
  calls: string[];
  logs: string[];
  ledger: MemoryNotifyLedger;
}

function harness(options: { ledger?: MemoryNotifyLedger; failComment?: number; failReaction?: boolean } = {}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const ledger = options.ledger ?? new MemoryNotifyLedger();
  let commentFailures = options.failComment ?? 0;
  let tick = 0;
  const deps: NotifierDeps = {
    ledger,
    log: createLogger('notify', {}, (line) => logs.push(line)),
    now: () => `t${(tick += 1)}`,
    github: async (repo, permissions) => {
      calls.push(`token ${repo.owner}/${repo.name} ${JSON.stringify(permissions)}`);
      return {
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
        },
      };
    },
  };
  return { deps, calls, logs, ledger };
}

describe('routing by source type', () => {
  it('sends a github-issue event to the github-issue notifier', async () => {
    const h = harness();
    await handleProgress(event(), h.deps);
    assert.deepEqual(h.calls, [
      'token JamieGeddes/factorial {"issues":"write"}',
      'react JamieGeddes/factorial#205 eyes',
      `comment JamieGeddes/factorial#205 ${startedComment(ID)}`,
    ]);
  });

  it('ignores a source type with no notifier', async () => {
    const h = harness();
    await handleProgress(event({ source: { type: 'jira-issue', url: 'https://example.atlassian.net/browse/X-1' } }), h.deps);
    assert.deepEqual(h.calls, []);
    assert.equal(h.ledger.claimed.size, 0);
    assert.match(h.logs.join('\n'), /no notifier for source type/);
  });

  it('ignores a type that is only a property of the registry object', async () => {
    const h = harness();
    await handleProgress(event({ source: { type: 'constructor', url: issueUrl } }), h.deps);
    assert.deepEqual(h.calls, []);
  });

  it('gives a rework turn nothing: Intake already reacts', async () => {
    for (const type of ['github-pull-request', 'github-pull-request-review', 'github-pull-request-review-comment', 'github-pull-request-comment']) {
      const h = harness();
      await handleProgress(event({ source: { type, url: 'https://github.com/JamieGeddes/factorial/pull/9#issuecomment-1' } }), h.deps);
      assert.deepEqual(h.calls, [], type);
      assert.equal(h.ledger.claimed.size, 0, type);
    }
  });

  it('ignores an event that fails the progress schema', async () => {
    const h = harness();
    await handleProgress({ ...event(), unexpected: true }, h.deps);
    await handleProgress('nonsense', h.deps);
    assert.deepEqual(h.calls, []);
    assert.match(h.logs.join('\n'), /progress event ignored/);
  });

  it('logs lines with the work item id', async () => {
    const h = harness();
    await handleProgress(event({ source: { type: 'jira-issue', url: 'https://example.com/x' } }), h.deps);
    assert.equal(JSON.parse(h.logs[0] ?? '{}').workItemId, ID);
  });
});

describe('the github-issue notifier: which events it acts on', () => {
  it('acts on the start of Build with no round', async () => {
    const h = harness();
    await handleProgress(event(), h.deps);
    assert.equal(h.calls.filter((c) => c.startsWith('comment')).length, 1);
  });

  const ignored: Array<[string, Partial<ProgressEvent>]> = [
    ['a later round of Build', { eventId: `${ID}:Build#2:started`, round: 2 }],
    ['the third round', { eventId: `${ID}:Build#3:started`, round: 3 }],
    ['the end of Build', { transition: 'succeeded' }],
    ['a failed Build', { transition: 'failed' }],
    ['ContinueBuild', { stage: 'ContinueBuild', round: 2 }],
    ['the start of Intake', { stage: 'Intake' }],
    ['the start of Prepare', { stage: 'Prepare' }],
    ['the start of Collect', { stage: 'Collect' }],
    ['the start of Review', { stage: 'Review' }],
    ['the end of the work item', { stage: 'WorkItem', transition: 'ended', status: 'pr-opened' }],
  ];
  for (const [name, overrides] of ignored) {
    it(`does nothing on ${name}`, async () => {
      const h = harness();
      await handleProgress(event(overrides), h.deps);
      assert.deepEqual(h.calls, []);
      assert.equal(h.ledger.claimed.size, 0);
    });
  }
});

describe('the github-issue notifier: idempotency', () => {
  it('posts nothing for a replayed event', async () => {
    const h = harness();
    await handleProgress(event(), h.deps);
    await handleProgress(event(), h.deps);
    assert.equal(h.calls.filter((c) => c.startsWith('comment')).length, 1);
    assert.equal(h.calls.filter((c) => c.startsWith('react')).length, 1);
  });

  it('posts nothing when the work item has no ledger row', async () => {
    const h = harness({ ledger: new MemoryNotifyLedger([ID2]) });
    await handleProgress(event(), h.deps);
    assert.deepEqual(h.calls, []);
  });

  it('notifies each work item once', async () => {
    const h = harness();
    await handleProgress(event(), h.deps);
    await handleProgress(event({ workItemId: ID2, eventId: `${ID2}:Build:started` }), h.deps);
    assert.equal(h.calls.filter((c) => c.startsWith('comment')).length, 2);
  });

  it('releases the claim when the comment fails, so a redelivery posts it', async () => {
    const h = harness({ failComment: 1 });
    await assert.rejects(handleProgress(event(), h.deps), /comment refused/);
    assert.equal(h.ledger.claimed.size, 0);
    await handleProgress(event(), h.deps);
    assert.equal(h.calls.filter((c) => c.startsWith('comment')).length, 1);
  });

  it('still posts the comment when the reaction fails', async () => {
    const h = harness({ failReaction: true });
    await handleProgress(event(), h.deps);
    assert.equal(h.calls.filter((c) => c.startsWith('comment')).length, 1);
    assert.match(h.logs.join('\n'), /reaction failed/);
  });

  it('releases the claim when no token can be minted', async () => {
    const h = harness();
    h.deps.github = async () => {
      throw new Error('no token');
    };
    await assert.rejects(handleProgress(event(), h.deps), /no token/);
    assert.equal(h.ledger.claimed.size, 0);
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
      'https://github.com/Someone/factorial/issues/205',
      'https://github.com/JamieGeddes/factorial/pull/205',
      'https://github.com/JamieGeddes/factorial/issues/abc',
      'https://github.com/JamieGeddes/factorial/issues/0',
      'https://github.com/JamieGeddes/factorial/issues/007',
      'https://github.com/JamieGeddes/factorial/issues/205/extra',
      'https://github.com/JamieGeddes/factorial/issues/205?x=1',
      'https://github.com/JamieGeddes/factorial/issues/205#issuecomment-1',
      'https://github.com/JamieGeddes/factorial/issues/99999999999999999999',
      'http://github.com/JamieGeddes/factorial/issues/205',
      'https://example.com/JamieGeddes/factorial/issues/205',
      '',
    ]) {
      assert.equal(issueNumberFromUrl(url, repository), undefined, url);
    }
  });

  it('logs and ignores an event whose number cannot be read, before any claim', async () => {
    const h = harness();
    await handleProgress(event({ source: { type: 'github-issue', url: 'https://github.com/JamieGeddes/other/issues/205' } }), h.deps);
    assert.deepEqual(h.calls, []);
    assert.equal(h.ledger.claimed.size, 0);
    assert.match(h.logs.join('\n'), /issue number not readable/);
  });
});

describe('the started comment', () => {
  it('names the work item and says what follows', () => {
    const text = startedComment(ID);
    assert.match(text, new RegExp(ID));
    assert.match(text, /pull request or a comment/);
  });
});
