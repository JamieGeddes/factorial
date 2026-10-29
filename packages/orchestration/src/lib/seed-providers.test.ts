import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTINUE_PROVIDERS } from '../functions/continue-build.ts';
import { PREPARE_PROVIDERS } from '../functions/prepare.ts';
import { REVIEW_PROVIDERS } from '../functions/prepare-review.ts';
import { assembleSeed, type Seed } from './seed.ts';
import { INSTRUCTIONS_FILE, MAX_INSTRUCTIONS_BYTES, diffProvider, roundNotesProvider } from './seed-providers.ts';
import { contextFor, newItem, reworkItem, reworkTurn, snapshotOf } from './seed-fixtures.ts';

const withInstructions = (text: string, reads: string[] = []) =>
  contextFor(newItem, {
    read: async (script) => {
      reads.push(script);
      return `ok:${text}`;
    },
  });

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

describe('instructionsProvider', () => {
  it("seeds the repository's instructions from the base branch and points the notes at them", async () => {
    const reads: string[] = [];
    const seed = await assembleSeed(PREPARE_PROVIDERS, withInstructions('Use tabs.\n', reads));
    assert.equal(file(seed, 'instructions.md'), 'Use tabs.\n');
    assert.match(file(seed, 'notes.md'), /# Notes\n\nThe repository has instructions .* \/workspace\/instructions\.md/);
    assert.match(reads[0]!, new RegExp(`git show 'origin/main:${INSTRUCTIONS_FILE.replace('.', '\\.')}'`));
    assert.doesNotMatch(reads[0]!, /HEAD/);
  });

  it('reads from the context base branch', async () => {
    const reads: string[] = [];
    await assembleSeed(PREPARE_PROVIDERS, { ...withInstructions('x', reads), baseBranch: 'release/1' });
    assert.match(reads[0]!, /origin\/release\/1:\.factorial\/instructions\.md/);
  });

  it('seeds nothing, and leaves the notes as they were, when the file is missing or empty', async () => {
    const plain = snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem)));
    for (const output of ['missing:', 'ok:', 'ok: \n']) {
      const seed = await assembleSeed(PREPARE_PROVIDERS, { ...contextFor(newItem), read: async () => output });
      assert.deepEqual(snapshotOf(seed), plain);
    }
  });

  it('redacts secrets and cuts the file to its cap', async () => {
    const seed = await assembleSeed(PREPARE_PROVIDERS, withInstructions(`token ghs_${'a'.repeat(36)}\n${'x'.repeat(MAX_INSTRUCTIONS_BYTES + 100)}`));
    const text = file(seed, 'instructions.md');
    assert.doesNotMatch(text, /ghs_a/);
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_INSTRUCTIONS_BYTES);
  });

  it("does not point a continuation's carried-over notes at the file again", async () => {
    const continuing = { baseCommit: 'b'.repeat(40), pushed: true, commitCount: 1 };
    const seed = await assembleSeed(CONTINUE_PROVIDERS, { ...withInstructions('Use tabs.'), round: 2, continuing });
    assert.equal(file(seed, 'instructions.md'), 'Use tabs.');
    assert.doesNotMatch(file(seed, 'notes.md'), /\/workspace\/instructions\.md/);
  });

  it('seeds the reviewer too', async () => {
    const seed = await assembleSeed(REVIEW_PROVIDERS, { ...withInstructions('Use tabs.'), role: 'reviewer' });
    assert.equal(file(seed, 'instructions.md'), 'Use tabs.');
  });
});
