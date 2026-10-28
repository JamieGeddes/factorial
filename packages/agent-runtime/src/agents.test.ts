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
  FACTORIAL_RUN_CONTRACT: '1',
  FACTORIAL_MAX_BUDGET_USD: '10',
  FACTORIAL_MAX_DURATION_SECONDS: '6600',
  AWS_REGION: 'eu-west-1',
});

describe('builderAgents', () => {
  const agents = builderAgents(config, true);
  const explore = agents.explore;

  it('returns exactly two agents, explore and plan', () => {
    assert.deepEqual(Object.keys(agents), ['explore', 'plan']);
  });

  it('gives plan the read-only tools, Write, WebFetch, web search, the builder model and a turn bound', () => {
    const plan = agents.plan;
    assert.ok(plan);
    assert.deepEqual(plan.tools, ['Read', 'Grep', 'Glob', 'Write', 'WebFetch', 'mcp__factorial__web_search']);
    for (const tool of ['Bash', 'Edit', 'NotebookEdit', 'Agent']) assert.ok(!plan.tools?.includes(tool), `${tool} must not be allowed`);
    assert.equal(plan.model, 'inherit');
    assert.equal(plan.maxTurns, 40);
    assert.match(plan.prompt, /Write \/workspace\/plan\.json first, then \/workspace\/plan\.md/);
  });

  it('leaves web search out of plan when the gateway is not configured', () => {
    assert.deepEqual(builderAgents(config, false).plan?.tools, ['Read', 'Grep', 'Glob', 'Write', 'WebFetch']);
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
