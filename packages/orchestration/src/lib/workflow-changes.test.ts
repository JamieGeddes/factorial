import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  MAX_WORKFLOW_SETTINGS_BYTES,
  WORKFLOW_SETTINGS_FILE,
  WorkflowChangeRefusedError,
  parseWorkflowSettings,
  workflowChangeAllowed,
  workflowPaths,
  workflowPathsOf,
  workflowPathsOmitted,
} from './workflow-changes.ts';

const OK = '{"schemaVersion":1,"allowWorkflowChanges":true}';
const cause = (error: Error): string => JSON.stringify({ errorType: error.name, errorMessage: error.message });

describe('workflowPaths', () => {
  it('finds paths under .github/workflows/ and .github/actions/, and nothing else', () => {
    assert.deepEqual(
      workflowPaths(['README.md', '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/CODEOWNERS', 'x/.github/workflows/y.yml', '.github/workflowsx/y.yml']),
      ['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
    );
    assert.deepEqual(workflowPaths([]), []);
  });

  it("tolerates git's quoting of unusual names", () => {
    assert.deepEqual(workflowPaths(['".github/workflows/a\\tb.yml"']), ['".github/workflows/a\\tb.yml"']);
  });
});

describe('parseWorkflowSettings', () => {
  it('allows only a valid v1 file that says true', () => {
    assert.deepEqual(parseWorkflowSettings(OK), { allowed: true });
    assert.deepEqual(parseWorkflowSettings('{"schemaVersion":1,"allowWorkflowChanges":true,"other":1}'), { allowed: true });
    assert.deepEqual(parseWorkflowSettings('{"schemaVersion":1,"allowWorkflowChanges":false}'), { allowed: false });
  });

  it('denies, with a problem, on anything else', () => {
    for (const text of [
      '',
      '{',
      'null',
      '[]',
      '"yes"',
      '{}',
      '{"allowWorkflowChanges":true}',
      '{"schemaVersion":2,"allowWorkflowChanges":true}',
      '{"schemaVersion":"1","allowWorkflowChanges":true}',
      '{"schemaVersion":1}',
      '{"schemaVersion":1,"allowWorkflowChanges":"true"}',
      '{"schemaVersion":1,"allowWorkflowChanges":1}',
      `{"schemaVersion":1,"allowWorkflowChanges":true,"pad":"${'x'.repeat(MAX_WORKFLOW_SETTINGS_BYTES)}"}`,
    ]) {
      const result = parseWorkflowSettings(text);
      assert.equal(result.allowed, false, text.slice(0, 60));
      assert.ok(result.problem, text.slice(0, 60));
    }
  });

  it("is allowed in Factorial's own .factorial/", async () => {
    const own = await readFile(new URL(`../../../../${WORKFLOW_SETTINGS_FILE}`, import.meta.url), 'utf8');
    assert.deepEqual(parseWorkflowSettings(own), { allowed: true });
  });
});

describe('workflowChangeAllowed', () => {
  const repo = { owner: 'o', name: 'r' };

  it("reads the file from the base branch, never the branch under review", async () => {
    const asked: unknown[] = [];
    const result = await workflowChangeAllowed(repo, 'main', async (...args) => (asked.push(args), OK));
    assert.deepEqual(result, { allowed: true });
    assert.deepEqual(asked, [[repo, WORKFLOW_SETTINGS_FILE, 'main', MAX_WORKFLOW_SETTINGS_BYTES + 1]]);
  });

  it('denies when the file is not there', async () => {
    assert.deepEqual(await workflowChangeAllowed(repo, 'main', async () => undefined), { allowed: false });
  });

  it('lets a read error through: it never allows', async () => {
    await assert.rejects(
      workflowChangeAllowed(repo, 'main', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
  });
});

describe('WorkflowChangeRefusedError', () => {
  it('names itself for the state machine and carries the paths back through its cause', () => {
    const error = new WorkflowChangeRefusedError(['.github/workflows/a.yml', '.github/actions/b/action.yml']);
    assert.equal(error.name, 'WorkflowChangeRefused');
    assert.deepEqual(workflowPathsOf(cause(error)), ['.github/workflows/a.yml', '.github/actions/b/action.yml']);
    assert.equal(workflowPathsOmitted(cause(error)), 0);
  });

  it('carries at most 20 paths and counts the rest', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `.github/workflows/w${i}.yml`);
    const error = new WorkflowChangeRefusedError(paths);
    assert.equal(workflowPathsOf(cause(error)).length, 20);
    assert.equal(workflowPathsOmitted(cause(error)), 5);
  });

  it('reads nothing from a cause it cannot parse', () => {
    for (const bad of [undefined, '', 'not json', '{}', '{"errorMessage":7}']) {
      assert.deepEqual(workflowPathsOf(bad), []);
      assert.equal(workflowPathsOmitted(bad), 0);
    }
  });
});
