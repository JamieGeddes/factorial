/**
 * Characterisation of what a session is seeded with (#166): the files placed
 * in /workspace and the sections added to the first message, for a new item,
 * a resumed item, a rework item, a later build round and the reviewer. The
 * fixtures under __snapshots__/seed were taken from the code before the
 * seed was assembled from providers, and must not change with a refactor: a
 * change here is a change in what a session is given. Regenerate on purpose
 * with UPDATE_SNAPSHOTS=1.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CONTINUE_PROVIDERS } from '../functions/continue-build.ts';
import { PREPARE_PROVIDERS } from '../functions/prepare.ts';
import { REVIEW_PROVIDERS } from '../functions/prepare-review.ts';
import { assembleSeed } from './seed.ts';
import { attempt, contextFor, newItem, planJson, planMarkdown, previousNotes, reworkItem, reworkTurn, sensitive, snapshotOf, summary, HEAD, type SeedSnapshot } from './seed-fixtures.ts';

/** The lists the stages seed with, over the same inputs the sessions were seeded from before. */
export const SCENARIOS: Record<string, () => Promise<SeedSnapshot>> = {
  'new-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem))),
  'resumed-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem, { resumedFrom: attempt }))),
  'rework-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(reworkItem, { rework: reworkTurn }))),
  'later-round': async () =>
    snapshotOf(
      await assembleSeed(
        CONTINUE_PROVIDERS,
        contextFor(reworkItem, {
          rework: reworkTurn,
          round: 2,
          continuing: { baseCommit: HEAD, pushed: true, commitCount: 2 },
          previousNotes,
          plan: { json: planJson, markdown: planMarkdown },
        }),
      ),
    ),
  reviewer: async () =>
    snapshotOf(
      await assembleSeed(
        REVIEW_PROVIDERS,
        contextFor(reworkItem, { role: 'reviewer', rework: reworkTurn, plan: { json: planJson, markdown: planMarkdown }, summary, sensitive }),
      ),
    ),
};

const fixture = (name: string): string => new URL(`./__snapshots__/seed/${name}.json`, import.meta.url).pathname;

/** Compare a seed with the committed fixture, or write the fixture when asked to. */
export function expectSnapshot(name: string, actual: SeedSnapshot): void {
  const sorted: SeedSnapshot = {
    files: Object.fromEntries(Object.entries(actual.files).sort(([a], [b]) => a.localeCompare(b))),
    sections: Object.fromEntries(Object.entries(actual.sections).sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(fixture(name))) {
    if (process.env.CI) assert.fail(`snapshot ${name} is missing`);
    writeFileSync(fixture(name), text);
  }
  assert.equal(text, readFileSync(fixture(name), 'utf8'), `seed snapshot ${name} changed`);
}

describe('what a session is seeded with', () => {
  for (const [name, seed] of Object.entries(SCENARIOS)) {
    it(`${name} matches its snapshot`, async () => {
      expectSnapshot(name, await seed());
    });
  }
});
