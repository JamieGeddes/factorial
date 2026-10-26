import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConfig } from './config.ts';

const env = {
  FACTORIAL_ROLE: 'builder',
  FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
  FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_BACKGROUND_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_MAX_TURNS: '150',
  FACTORIAL_MAX_BUDGET_USD: '10',
  FACTORIAL_MAX_DURATION_SECONDS: '6600',
  AWS_REGION: 'eu-west-1',
};

describe('readConfig', () => {
  it('reads the Runtime version settings', () => {
    const config = readConfig({ ...env, FACTORIAL_WEB_SEARCH_GATEWAY_URL: 'https://gateway.example/mcp' });
    assert.equal(config.role, 'builder');
    assert.equal(config.model, 'eu.anthropic.claude-sonnet-5-5');
    assert.equal(config.exploreModel, 'eu.anthropic.claude-haiku-5-5');
    assert.equal(config.backgroundModel, 'eu.anthropic.claude-haiku-5-5');
    assert.equal(config.maxTurns, 150);
    assert.equal(config.maxBudgetUsd, 10);
    assert.equal(config.maxDurationSeconds, 6600);
    assert.equal(config.webSearchGatewayUrl, 'https://gateway.example/mcp');
    assert.equal(config.workspace, '/workspace');
  });

  it('reads a reviewer, which has no explore subagent', () => {
    const { FACTORIAL_EXPLORE_MODEL: _, ...reviewer } = env;
    const config = readConfig({ ...reviewer, FACTORIAL_ROLE: 'reviewer' });
    assert.equal(config.role, 'reviewer');
    assert.equal(config.exploreModel, undefined);
    assert.throws(() => readConfig({ ...reviewer, FACTORIAL_ROLE: 'builder' }), /FACTORIAL_EXPLORE_MODEL/);
  });

  it('turns web search off when no gateway is set', () => {
    assert.equal(readConfig(env).webSearchGatewayUrl, undefined);
  });

  it('rejects missing or invalid settings', () => {
    assert.throws(() => readConfig({ ...env, FACTORIAL_MODEL: '' }), /FACTORIAL_MODEL/);
    assert.throws(() => readConfig({ ...env, FACTORIAL_ROLE: 'planner' }), /FACTORIAL_ROLE/);
    assert.throws(() => readConfig({ ...env, FACTORIAL_MAX_TURNS: '1.5' }), /integer/);
    assert.throws(() => readConfig({ ...env, FACTORIAL_MAX_BUDGET_USD: '0' }), /positive/);
  });
});
