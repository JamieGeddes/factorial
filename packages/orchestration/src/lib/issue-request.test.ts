import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { issueRequest, parseIssueRequest } from './issue-request.ts';

const URL = 'https://github.com/JamieGeddes/factorial/issues/169';

describe('the issue request snapshot (#169)', () => {
  it('is the issue as read, redacted and capped as a WorkItem is', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const request = issueRequest({ title: 'x'.repeat(300), body: `Use ${token} here.\n${'y'.repeat(70_000)}` }, URL);
    assert.equal(request.title.length, 256);
    assert.ok(request.body.length <= 65_536);
    assert.ok(!request.body.includes(token));
    assert.equal(request.url, URL);
  });

  it('reads back what was stored', () => {
    const request = issueRequest({ title: 'Propose', body: 'The body.' }, URL);
    assert.deepEqual(parseIssueRequest(JSON.stringify(request)), request);
  });

  it('refuses anything else, so a turn is never seeded from a partial or foreign request', () => {
    for (const text of [undefined, 'not json', '{}', JSON.stringify({ title: 'a', body: 1, url: URL }), JSON.stringify({ title: 'a', body: 'b', url: 'https://evil.example/x' }), JSON.stringify({ title: 'a'.repeat(257), body: 'b', url: URL })]) {
      assert.equal(parseIssueRequest(text), undefined, String(text));
    }
  });
});
