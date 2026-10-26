import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SUMMARY_HEADINGS, cutText, parseBuilderSummary, parseReworkPoints, parseStepLine, replaceEmDashes } from './builder-summary.ts';

const full = [
  SUMMARY_HEADINGS.summary,
  'Adds a thing.',
  '',
  SUMMARY_HEADINGS.behaviour,
  'Operators see the thing.',
  '',
  SUMMARY_HEADINGS.breaking,
  'None.',
  '',
  SUMMARY_HEADINGS.uncertainties,
  '- Assumed X.',
  '- Could not run Y.',
  '',
  SUMMARY_HEADINGS.notTested,
  '- The live deploy.',
  '',
  SUMMARY_HEADINGS.planSteps,
  '- one: done',
  '- two: skipped: not needed',
  '- three: changed: split in two',
].join('\n');

describe('parseBuilderSummary', () => {
  it('reads all five sections', () => {
    const parsed = parseBuilderSummary(full)!;
    assert.equal(parsed.summary, 'Adds a thing.');
    assert.equal(parsed.behaviour, 'Operators see the thing.');
    assert.equal(parsed.breaking, 'None.');
    assert.deepEqual(parsed.uncertainties, ['Assumed X.', 'Could not run Y.']);
    assert.deepEqual(parsed.notTested, ['The live deploy.']);
    assert.deepEqual(parsed.steps.map((s) => [s.id, s.status, s.note]), [
      ['one', 'done', ''],
      ['two', 'skipped', 'not needed'],
      ['three', 'changed', 'split in two'],
    ]);
  });

  it('is undefined for a free-form summary', () => {
    assert.equal(parseBuilderSummary('# Done\n\nI fixed it.'), undefined);
  });

  it('tolerates missing and empty sections', () => {
    const parsed = parseBuilderSummary('## Summary\n\n## Uncertainties\n\n## Plan steps\n- a: done')!;
    assert.equal(parsed.summary, undefined);
    assert.equal(parsed.behaviour, undefined);
    assert.deepEqual(parsed.uncertainties, []);
    assert.equal(parsed.steps.length, 1);
  });

  it('matches headings case-insensitively and stops a section at the next heading', () => {
    const parsed = parseBuilderSummary('## summary\nText\n## Other\nignored\n')!;
    assert.equal(parsed.summary, 'Text');
  });
});

describe('parseReworkPoints', () => {
  it('keys each answer by its point number, first line per number winning', () => {
    const points = parseReworkPoints(['- 1: Renamed the file.', '- 2: Not changed: the name is fixed by the contract.', '- 1: again', 'stray text']);
    assert.deepEqual([...points], [
      [1, 'Renamed the file.'],
      [2, 'Not changed: the name is fixed by the contract.'],
    ]);
  });

  it('accepts the common variations of the line form', () => {
    const points = parseReworkPoints(['* Point 3. Done', '`4`) Added a test', '5 - Reverted']);
    assert.deepEqual([...points], [
      [3, 'Done'],
      [4, 'Added a test'],
      [5, 'Reverted'],
    ]);
  });

  it('is read from the summary as its own section, empty when absent', () => {
    assert.equal(parseBuilderSummary(full)!.reworkPoints.size, 0);
    const parsed = parseBuilderSummary(`${full}\n\n${SUMMARY_HEADINGS.reworkPoints}\n- 1: Fixed.\n`)!;
    assert.equal(parsed.reworkPoints.get(1), 'Fixed.');
    assert.equal(parsed.steps.length, 3);
  });
});

describe('parseStepLine', () => {
  it('reads the status only immediately after the id', () => {
    assert.equal(parseStepLine('- one: changed: it is done elsewhere').status, 'changed');
    assert.equal(parseStepLine('- one: it was done').status, undefined);
    assert.equal(parseStepLine('one was skipped').status, undefined);
    assert.equal(parseStepLine('- `one`: done').id, 'one');
  });
});

describe('text helpers', () => {
  it('cuts with an ellipsis only when over the cap', () => {
    assert.equal(cutText('abc', 5), 'abc');
    assert.equal(cutText('abcdefgh', 5), 'abcd…');
  });

  it('replaces em and en dashes', () => {
    assert.equal(replaceEmDashes('a — b – c'), 'a - b - c');
  });
});
