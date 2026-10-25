import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderAgents } from './agents.ts';
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
  const explore = agents.explore;

  it('returns exactly one agent, explore', () => {
    assert.deepEqual(Object.keys(agents), ['explore']);
  });

  it('gives explore only the read-only tools', () => {
    assert.ok(explore);
    assert.deepEqual(explore.tools, ['Read', 'Grep', 'Glob']);
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']) {
      assert.ok(!explore.tools?.includes(tool), `${tool} must not be allowed`);
    }
  });

  it('runs explore on the explore model, not the builder model', () => {
    assert.notEqual(config.exploreModel, config.model);
    assert.equal(explore?.model, config.exploreModel);
    assert.notEqual(explore?.model, config.model);
  });

  it('bounds explore with a positive integer maxTurns', () => {
    assert.ok(Number.isInteger(explore?.maxTurns));
    assert.ok((explore?.maxTurns ?? 0) > 0);
  });
});
