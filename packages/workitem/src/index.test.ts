import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WORKITEM_SCHEMA_VERSION,
  WorkItemValidationError,
  assertWorkItem,
  parseWorkItem,
  validateWorkItem,
  type WorkItem,
} from './index.ts';

const examplesDir = fileURLToPath(
  new URL('../../../contracts/workitem/v1/examples/', import.meta.url),
);

async function loadExample(name: string): Promise<unknown> {
  const text = await readFile(path.join(examplesDir, name), 'utf8');
  return JSON.parse(text) as unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('WorkItem schema', () => {
  it('accepts every example in the contract directory', async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0, 'expected at least one example');
    for (const file of files) {
      const result = validateWorkItem(await loadExample(file));
      assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    }
  });

  it('returns a typed value on success', async () => {
    const item = parseWorkItem(await loadExample('github-issue.json'));
    const typed: WorkItem = item;
    assert.equal(typed.schemaVersion, WORKITEM_SCHEMA_VERSION);
    assert.equal(typed.source.type, 'github-issue');
    assert.equal(typed.repository.provider, 'github');
  });

  it('rejects a missing required field', async () => {
    const item = clone(await loadExample('github-issue.json')) as Record<string, unknown>;
    delete item.requestedBy;
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes('requestedBy')));
  });

  it('rejects unknown properties at the root', async () => {
    const item = clone(await loadExample('github-issue.json')) as Record<string, unknown>;
    item.priority = 'high';
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes('"priority"')));
  });

  it('rejects unknown properties in nested objects', async () => {
    const item = clone(await loadExample('github-issue.json')) as { source: Record<string, unknown> };
    item.source.labels = ['bug'];
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.startsWith('/source')));
  });

  it('rejects a schemaVersion other than 1', async () => {
    const item = clone(await loadExample('github-issue.json')) as Record<string, unknown>;
    item.schemaVersion = 2;
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects a malformed id, url and timestamp', async () => {
    const base = await loadExample('github-issue.json');

    const badId = clone(base) as Record<string, unknown>;
    badId.id = 'not-a-uuid';
    assert.equal(validateWorkItem(badId).ok, false);

    const badUrl = clone(base) as { source: Record<string, unknown> };
    badUrl.source.url = 'issues/1';
    assert.equal(validateWorkItem(badUrl).ok, false);

    const badDate = clone(base) as Record<string, unknown>;
    badDate.createdAt = '16/10/2026';
    assert.equal(validateWorkItem(badDate).ok, false);
  });

  it('rejects a trigger type that is not kebab-case', async () => {
    const item = clone(await loadExample('github-issue.json')) as { source: Record<string, unknown> };
    item.source.type = 'GitHub_Issue';
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects an unsupported repository provider', async () => {
    const item = clone(await loadExample('github-issue.json')) as { repository: Record<string, unknown> };
    item.repository.provider = 'gitlab';
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('allows an empty body', async () => {
    const item = clone(await loadExample('github-issue.json')) as Record<string, unknown>;
    item.body = '';
    assert.equal(validateWorkItem(item).ok, true);
  });

  it('assertWorkItem throws a WorkItemValidationError listing every problem', () => {
    assert.throws(
      () => assertWorkItem({ schemaVersion: 1 }),
      (error: unknown) =>
        error instanceof WorkItemValidationError &&
        error.errors.length >= 7 &&
        error.message.startsWith('Invalid WorkItem:'),
    );
  });

  it('rejects non-object input', () => {
    assert.equal(validateWorkItem(null).ok, false);
    assert.equal(validateWorkItem('WorkItem').ok, false);
    assert.equal(validateWorkItem([]).ok, false);
  });
});
