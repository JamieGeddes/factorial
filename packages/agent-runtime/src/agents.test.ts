import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderAgents, explore } from './agents.ts';
import { readConfig } from './config.ts';

const config = readConfig({
  FACTORIAL_ROLE: 'builder',
  FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
  FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_BACKGROUND_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_MAX_TURNS: '150',
  FACTORIAL_MAX_BUDGET_USD: '10',
  FACTORIAL_MAX_DURATION_SECONDS: '6600',
  AWS_REGION: 'eu-west-1',
});

describe('builderAgents', () => {
  const agents = builderAgents(config);
  const agent = agents.explore;

  it('returns exactly one agent, explore', () => {
    assert.deepEqual(Object.keys(agents), ['explore']);
    assert.deepEqual(agent, explore(config));
  });

  it('gives explore read-only tools only', () => {
    assert.deepEqual(agent?.tools, ['Read', 'Grep', 'Glob']);
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']) {
      assert.ok(!agent?.tools?.includes(tool), `explore must not have ${tool}`);
    }
  });

  it('runs explore on the explore model, not the builder model', () => {
    assert.notEqual(config.exploreModel, config.model);
    assert.equal(agent?.model, config.exploreModel);
    assert.notEqual(agent?.model, config.model);
  });

  it('limits explore to a positive integer number of turns', () => {
    assert.ok(Number.isInteger(agent?.maxTurns));
    assert.ok((agent?.maxTurns ?? 0) > 0);
    assert.equal(agent?.maxTurns, 30);
  });
});
