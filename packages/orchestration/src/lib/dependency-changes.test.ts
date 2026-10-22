import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEPENDENCY_SECTION, dependencyChanges, parseDependencyChanges } from './dependency-changes.ts';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
const section = (value: unknown): string => `${DEPENDENCY_SECTION}${encode(value)}`;

describe('dependencyChanges', () => {
  it('diffs the union of dependencies and devDependencies, added and removed', () => {
    const result = dependencyChanges({
      old: { dependencies: { left: '1.0.0', both: '1.0.0' }, devDependencies: { devold: '1.0.0' } },
      new: { dependencies: { right: '2.0.0', both: '2.0.0' }, devDependencies: { devnew: '1.0.0' } },
      licences: { right: 'MIT', devnew: 'Apache-2.0' },
    });
    assert.deepEqual(result, {
      added: [
        { name: 'right', licence: 'MIT' },
        { name: 'devnew', licence: 'Apache-2.0' },
      ],
      removed: ['left', 'devold'],
    });
  });

  it('leaves the licence off when the lockfile does not record one', () => {
    const result = dependencyChanges({ old: {}, new: { dependencies: { left: '1.0.0' } }, licences: {} });
    assert.deepEqual(result, { added: [{ name: 'left' }], removed: [] });
  });

  it('ignores non-string names, specs and licences', () => {
    const result = dependencyChanges({ old: {}, new: { bad: 3, '': '1', good: '^1' }, licences: { good: null, ok: 'MIT', bad: 7 } });
    assert.deepEqual(result, { added: [{ name: 'good' }], removed: [] });
  });

  it('caps both lists', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg${i}`, '1.0.0']));
    assert.equal(dependencyChanges({ old: {}, new: many, licences: {} }).added.length, 20);
    assert.equal(dependencyChanges({ old: many, new: {}, licences: {} }).removed.length, 20);
  });

  it('yields empty for a wrong shape or nothing at all', () => {
    assert.deepEqual(dependencyChanges(undefined), { added: [], removed: [] });
    assert.deepEqual(dependencyChanges('nope'), { added: [], removed: [] });
    assert.deepEqual(dependencyChanges([1, 2]), { added: [], removed: [] });
    assert.deepEqual(dependencyChanges({}), { added: [], removed: [] });
  });
});

describe('parseDependencyChanges', () => {
  it('decodes the base64 section and diffs it', () => {
    assert.deepEqual(parseDependencyChanges(encode({ old: { a: "1" }, new: { a: "1", b: "2" }, licences: { b: "ISC" } })), {
      added: [{ name: 'b', licence: 'ISC' }],
      removed: [],
    });
  });

  it('yields empty for a missing, malformed or oversized section, never a throw', () => {
    assert.deepEqual(parseDependencyChanges(undefined), { added: [], removed: [] });
    assert.deepEqual(parseDependencyChanges(''), { added: [], removed: [] });
    assert.deepEqual(parseDependencyChanges('!!!not base64'), { added: [], removed: [] });
    assert.deepEqual(parseDependencyChanges(Buffer.from('not json').toString('base64')), { added: [], removed: [] });
    assert.deepEqual(parseDependencyChanges(encode([1]), ), { added: [], removed: [] });
    assert.deepEqual(parseDependencyChanges('A'.repeat(1_000_001)), { added: [], removed: [] });
  });
});
