import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyChanges, isNonFunctionalPath } from './classify-changes.ts';

describe('isNonFunctionalPath', () => {
  it('treats documentation and repository meta files as non-functional', () => {
    for (const path of [
      'README.md',
      'CLAUDE.md',
      'LICENSE',
      '.editorconfig',
      '.github/CODEOWNERS',
      'CONTRIBUTING.md',
      'docs/design-conversation.md',
      'docs/bootstrap.md',
    ]) {
      assert.equal(isNonFunctionalPath(path), true, path);
    }
  });

  it('treats everything else as functional', () => {
    for (const path of [
      'packages/orchestration/src/index.ts',
      'templates/30-orchestration.yml',
      'contracts/workitem/v1/workitem.schema.json',
      'scripts/classify-changes.ts',
      'agent-runtime/Dockerfile',
      'invoker/Dockerfile',
      '.github/workflows/deploy.yml',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      '.nvmrc',
      '.cfnlintrc.yml',
    ]) {
      assert.equal(isNonFunctionalPath(path), false, path);
    }
  });

  it('does not treat a file whose name starts with a directory name as being inside it', () => {
    assert.equal(isNonFunctionalPath('docsious/notes.md'), false);
  });
});

describe('classifyChanges', () => {
  it('is functional when any changed path is functional', () => {
    const result = classifyChanges(['README.md', 'packages/workitem/src/index.ts']);
    assert.equal(result.functional, true);
    assert.deepEqual(result.functionalPaths, ['packages/workitem/src/index.ts']);
  });

  it('is non-functional when every changed path is documentation or metadata', () => {
    const result = classifyChanges([
      'docs/design-conversation.md',
      'README.md',
      'CLAUDE.md',
      'LICENSE',
      '.editorconfig',
      '.github/CODEOWNERS',
    ]);
    assert.equal(result.functional, false);
    assert.deepEqual(result.functionalPaths, []);
  });

  it('treats an empty change set as non-functional at the path level', () => {
    // Vacuously, no changed path is functional. An empty diff as a whole is an
    // unknown state, so the CLI overrides this and reports functional; that
    // decision lives in main(), not here.
    const result = classifyChanges([]);
    assert.equal(result.functional, false);
    assert.deepEqual(result.functionalPaths, []);
  });
});

