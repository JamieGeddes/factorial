import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkItem } from '@factorial/workitem';

import { lineageAttributes } from './lineage.ts';

const base: WorkItem = {
  schemaVersion: 1,
  id: '3a9e2c4b-8d1f-4e6a-b5c7-0f1e2d3c4b5a',
  source: { type: 'github-issue', id: '1', url: 'https://github.com/o/r/issues/1' },
  repository: { provider: 'github', owner: 'o', name: 'r' },
  title: 't',
  body: '',
  requestedBy: 'u',
  createdAt: '2026-10-19T09:00:00Z',
};

test('an item without lineage adds no attributes', () => {
  assert.deepEqual(lineageAttributes(base), {});
});

test('group and parent are flattened onto the row', () => {
  const item: WorkItem = {
    ...base,
    group: { id: 'b2c4d6e8-1a3c-4e5f-8a7b-9c0d1e2f3a4b', size: 3, index: 2 },
    parentId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  };
  assert.deepEqual(lineageAttributes(item), {
    groupId: 'b2c4d6e8-1a3c-4e5f-8a7b-9c0d1e2f3a4b',
    groupSize: 3,
    groupIndex: 2,
    parentId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  });
});

test('a parent without a group sets only parentId', () => {
  assert.deepEqual(lineageAttributes({ ...base, parentId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c' }), {
    parentId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  });
});
