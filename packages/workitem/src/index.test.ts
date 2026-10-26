import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TRIGGER_TYPES,
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

describe('WorkItem rework context', () => {
  it('accepts a valid rework item', async () => {
    const item = parseWorkItem(await loadExample('github-pr-rework.json'));
    assert.equal(item.context?.kind, 'rework');
    assert.equal(item.context?.pullRequest.number, 7);
    assert.equal(item.context?.cause, 'review');
    assert.equal(item.context?.details.length, 2);
  });

  it('rejects an unknown context kind', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: Record<string, unknown>;
    };
    item.context.kind = 'escalation';
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.startsWith('/context/kind')));
  });

  it('accepts each cause, including a request made in a comment', async () => {
    for (const cause of ['review', 'checks-failed', 'comment']) {
      const item = clone(await loadExample('github-pr-rework.json')) as { context: Record<string, unknown> };
      item.context.cause = cause;
      assert.equal(validateWorkItem(item).ok, true, cause);
    }
  });

  it('rejects an unknown cause', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: Record<string, unknown>;
    };
    item.context.cause = 'whim';
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects a branch that is not a Factorial branch', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: Record<string, unknown>;
    };
    item.context.branch = 'feature/rework';
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.startsWith('/context/branch')));
  });

  it('rejects a malformed previousWorkItemId', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: Record<string, unknown>;
    };
    item.context.previousWorkItemId = 'not-a-uuid';
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects unknown properties inside context and its nested objects', async () => {
    const base = await loadExample('github-pr-rework.json');

    const extraTop = clone(base) as { context: Record<string, unknown> };
    extraTop.context.priority = 'high';
    assert.equal(validateWorkItem(extraTop).ok, false);

    const extraDetail = clone(base) as {
      context: { details: Array<Record<string, unknown>> };
    };
    extraDetail.context.details[0]!.severity = 'blocker';
    assert.equal(validateWorkItem(extraDetail).ok, false);
  });

  it('rejects a detail body longer than 8,000 characters', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: { details: Array<{ body: string }> };
    };
    item.context.details[0]!.body = 'x'.repeat(8001);
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects more than 50 details', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: { details: Array<{ author: string; body: string }> };
    };
    item.context.details = Array.from({ length: 51 }, (_, i) => ({
      author: 'JamieGeddes',
      body: `comment ${i}`,
    }));
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('rejects a detail missing author or body', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as {
      context: { details: Array<Record<string, unknown>> };
    };
    delete item.context.details[0]!.author;
    assert.equal(validateWorkItem(item).ok, false);
  });

  it('still accepts the issue example without a context field', async () => {
    const item = parseWorkItem(await loadExample('github-issue.json'));
    assert.equal(item.context, undefined);
  });
});

describe('WorkItem inReplyTo', () => {
  it('accepts an item that continues a pull request', async () => {
    const item = parseWorkItem(await loadExample('github-pr-comment.json'));
    assert.deepEqual(item.inReplyTo, { kind: 'pull-request', number: 87 });
    assert.equal(item.source.type, TRIGGER_TYPES.githubPullRequestComment);
    assert.equal(item.context, undefined);
  });

  it('still accepts an item without it', async () => {
    const item = parseWorkItem(await loadExample('github-issue.json'));
    assert.equal(item.inReplyTo, undefined);
  });

  it('rejects an unknown kind', async () => {
    const item = clone(await loadExample('github-pr-comment.json')) as { inReplyTo: Record<string, unknown> };
    item.inReplyTo.kind = 'issue';
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.startsWith('/inReplyTo/kind')));
  });

  it('rejects a missing, zero or fractional number', async () => {
    const base = await loadExample('github-pr-comment.json');
    const missing = clone(base) as { inReplyTo: Record<string, unknown> };
    delete missing.inReplyTo.number;
    assert.equal(validateWorkItem(missing).ok, false);
    for (const value of [0, 2.5, '87']) {
      const item = clone(base) as { inReplyTo: Record<string, unknown> };
      item.inReplyTo.number = value;
      assert.equal(validateWorkItem(item).ok, false, String(value));
    }
  });

  it('rejects unknown properties', async () => {
    const item = clone(await loadExample('github-pr-comment.json')) as { inReplyTo: Record<string, unknown> };
    item.inReplyTo.branch = 'factorial/146b11c0-ca7d-11f1-9d6b-acd4bff0d455';
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes('"branch"')));
  });

  it('rejects an item that carries both inReplyTo and context', async () => {
    const item = clone(await loadExample('github-pr-rework.json')) as Record<string, unknown>;
    item.inReplyTo = { kind: 'pull-request', number: 7 };
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.includes('/context must not be present here'));
  });
});

describe('WorkItem lineage', () => {
  it('accepts a fan-out sibling and a planner child', async () => {
    const sibling = parseWorkItem(await loadExample('fan-out-sibling.json'));
    assert.deepEqual(sibling.group, { id: 'b2c4d6e8-1a3c-4e5f-8a7b-9c0d1e2f3a4b', size: 3, index: 2 });
    assert.equal(sibling.parentId, undefined);
    const child = parseWorkItem(await loadExample('planner-child.json'));
    assert.equal(child.parentId, '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c');
  });

  it('accepts index equal to size', async () => {
    const item = clone(await loadExample('fan-out-sibling.json')) as { group: Record<string, unknown> };
    item.group.index = 3;
    assert.equal(validateWorkItem(item).ok, true);
  });

  it('rejects an index greater than size', async () => {
    const item = clone(await loadExample('fan-out-sibling.json')) as { group: Record<string, unknown> };
    item.group.index = 4;
    const result = validateWorkItem(item);
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.startsWith('/group/index')));
  });

  it('rejects a zero size or index, and a fractional one', async () => {
    const base = await loadExample('fan-out-sibling.json');
    for (const [field, value] of [['size', 0], ['index', 0], ['size', 2.5]] as const) {
      const item = clone(base) as { group: Record<string, unknown> };
      item.group[field] = value;
      assert.equal(validateWorkItem(item).ok, false, `${field} = ${value}`);
    }
  });

  it('rejects a group missing a field or carrying an unknown one', async () => {
    const base = await loadExample('fan-out-sibling.json');
    const missing = clone(base) as { group: Record<string, unknown> };
    delete missing.group.size;
    assert.equal(validateWorkItem(missing).ok, false);
    const extra = clone(base) as { group: Record<string, unknown> };
    extra.group.name = 'runtime upgrade';
    assert.equal(validateWorkItem(extra).ok, false);
  });

  it('rejects malformed group and parent ids', async () => {
    const badGroup = clone(await loadExample('fan-out-sibling.json')) as { group: Record<string, unknown> };
    badGroup.group.id = 'group-1';
    assert.equal(validateWorkItem(badGroup).ok, false);
    const badParent = clone(await loadExample('planner-child.json')) as Record<string, unknown>;
    badParent.parentId = 'parent';
    assert.equal(validateWorkItem(badParent).ok, false);
  });
});
