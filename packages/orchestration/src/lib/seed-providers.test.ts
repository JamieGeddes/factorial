import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTINUE_PROVIDERS } from '../functions/continue-build.ts';
import { PREPARE_PROVIDERS } from '../functions/prepare.ts';
import { REVIEW_PROVIDERS } from '../functions/prepare-review.ts';
import { assembleSeed, sectionText, type Seed, type SeedProvider } from './seed.ts';
import { diffProvider, roundNotesProvider } from './seed-providers.ts';
import { contextFor, newItem, reworkItem, reworkTurn, snapshotOf } from './seed-fixtures.ts';

const file = (seed: Seed, path: string): string => {
  const f = seed.files.find((x) => x.path === path);
  assert.ok(f && 'content' in f, `${path} is seeded`);
  return f.content;
};

describe('the lists', () => {
  it('seed a new item with the request and notes, and a rework item with its points', async () => {
    assert.deepEqual(Object.keys(snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem))).files), ['workitem.json', 'notes.md']);
    const rework = await assembleSeed(PREPARE_PROVIDERS, contextFor(reworkItem, { rework: reworkTurn }));
    assert.deepEqual(Object.keys(snapshotOf(rework).files), ['workitem.json', 'notes.md', 'rework.md']);
    assert.equal(rework.data.reworkPoints?.length, 1);
  });

  it('give the same points to every stage, so their numbering holds', async () => {
    const prepare = await assembleSeed(PREPARE_PROVIDERS, contextFor(reworkItem, { rework: reworkTurn }));
    const review = await assembleSeed(REVIEW_PROVIDERS, contextFor(reworkItem, { role: 'reviewer', rework: reworkTurn }));
    assert.equal(file(prepare, 'rework.md'), file(review, 'rework.md'));
    assert.deepEqual(prepare.data.reworkPoints, review.data.reworkPoints);
  });

  it('name every provider, so a refusal says whose it was', () => {
    for (const p of [...PREPARE_PROVIDERS, ...CONTINUE_PROVIDERS, ...REVIEW_PROVIDERS]) assert.notEqual(p.name, '');
  });
});

describe('roundNotesProvider', () => {
  const continuing = { baseCommit: 'b'.repeat(40), pushed: true, commitCount: 1 };

  it('falls back to the starting notes when the previous round left none', async () => {
    const seed = await assembleSeed([roundNotesProvider], contextFor(newItem, { round: 2, continuing }));
    assert.match(file(seed, 'notes.md'), /^# Task\n[\s\S]*# Notes\n[\s\S]*# Continuing \(round 2\)/);
  });

  it('needs to know what the previous round left', async () => {
    await assert.rejects(assembleSeed([roundNotesProvider], contextFor(newItem, { round: 2 })), /previous round/);
  });
});

describe('diffProvider', () => {
  it('diffs against the base branch, never the branch under work', async () => {
    const seed = await assembleSeed([diffProvider], contextFor(newItem, { baseBranch: 'release/1' }));
    const f = seed.files[0]!;
    assert.ok('command' in f);
    assert.match(f.command, /'origin\/release\/1\.\.\.HEAD'/);
  });

  it('refuses a base branch that is not a branch name', async () => {
    await assert.rejects(assembleSeed([diffProvider], contextFor(newItem, { baseBranch: 'main; rm -rf /' })), /base branch/);
  });
});

describe('the seam', () => {
  it('seeds what a new provider returns, in list order, from a function and a list entry', async () => {
    const extra: SeedProvider = () => ({
      files: [{ path: 'extra.md', content: 'Extra context.\n', cap: 100 }],
      sections: [{ id: 'extra', text: 'Extra section.', cap: 100 }],
    });
    const middle = [...PREPARE_PROVIDERS.slice(0, 1), extra, ...PREPARE_PROVIDERS.slice(1)];
    const atEnd = [...PREPARE_PROVIDERS, extra];

    const plain = await assembleSeed(PREPARE_PROVIDERS, contextFor(reworkItem, { rework: reworkTurn }));
    const names = plain.files.map((f) => f.path);
    const inMiddle = await assembleSeed(middle, contextFor(reworkItem, { rework: reworkTurn }));
    assert.deepEqual(inMiddle.files.map((f) => f.path), [names[0], 'extra.md', ...names.slice(1)]);
    const last = await assembleSeed(atEnd, contextFor(reworkItem, { rework: reworkTurn }));
    assert.deepEqual(last.files.map((f) => f.path), [...names, 'extra.md']);

    assert.equal(file(last, 'extra.md'), 'Extra context.\n');
    assert.equal(sectionText(last, 'extra'), 'Extra section.');
    assert.deepEqual(last.sections.map((s) => s.id), [...plain.sections.map((s) => s.id), 'extra']);
    assert.equal(plain.files.some((f) => f.path === 'extra.md'), false, 'the real list is untouched');
  });
});
