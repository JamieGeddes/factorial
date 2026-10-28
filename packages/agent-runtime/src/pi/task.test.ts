import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILDER_SUBAGENTS, MAX_CONCURRENT_SUBAGENTS } from '../agents.ts';
import { taskDescription, taskResult } from './task.ts';

describe('taskDescription', () => {
  const text = taskDescription(BUILDER_SUBAGENTS);

  it('briefs the model on delegating and lists every subagent by its description', () => {
    for (const heading of ['When to use it:', 'How to brief it:', 'Running several:', 'What comes back:']) assert.ok(text.includes(heading), heading);
    assert.ok(text.includes(`at most ${MAX_CONCURRENT_SUBAGENTS} run together`));
    for (const [name, spec] of Object.entries(BUILDER_SUBAGENTS)) assert.ok(text.includes(`- ${name}: ${spec.description}`), name);
  });

  it("names no Claude Code tool", () => {
    assert.doesNotMatch(text, /\b(?:Agent tool|Bash|Grep|Glob|WebFetch)\b/);
  });
});

describe('taskResult', () => {
  it('returns the reply, marks one cut off at the turn limit as partial, and says when there was none', () => {
    assert.equal(taskResult('explore', 'Found it in src/a.ts:3.', undefined), 'Found it in src/a.ts:3.');
    assert.equal(taskResult('explore', 'So far: src/a.ts.', 30), '[partial: the explore subagent stopped at its 30-turn limit before it finished]\n\nSo far: src/a.ts.');
    assert.equal(taskResult('plan', '', undefined), 'The plan subagent stopped without a reply.');
  });
});
