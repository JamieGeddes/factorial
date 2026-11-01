import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConfig } from './config.ts';

const env = {
  FACTORIAL_ROLE: 'builder',
  FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
  FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_BACKGROUND_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_MAX_TURNS: '150',
  FACTORIAL_RUN_CONTRACT: '1',
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
    assert.throws(() => readConfig({ ...env, FACTORIAL_RUN_CONTRACT: undefined }), /FACTORIAL_RUN_CONTRACT must be 1/);
    assert.throws(() => readConfig({ ...env, FACTORIAL_RUN_CONTRACT: '2' }), /FACTORIAL_RUN_CONTRACT must be 1/);
    assert.throws(() => readConfig({ ...env, FACTORIAL_MAX_BUDGET_USD: '0' }), /positive/);
  });

  describe('the npm mirror', () => {
    const mirror = {
      FACTORIAL_CODEARTIFACT_DOMAIN: 'factorial',
      FACTORIAL_CODEARTIFACT_DOMAIN_OWNER: '123456789012',
      FACTORIAL_CODEARTIFACT_REPOSITORY: 'factorial-npm',
    };

    it('builds the registry from the three variables and the region', () => {
      assert.deepEqual(readConfig({ ...env, ...mirror }).npmMirror, {
        domain: 'factorial',
        domainOwner: '123456789012',
        repository: 'factorial-npm',
        registry: 'https://factorial-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/factorial-npm/',
      });
    });

    it('is absent when none is set, as on the reviewer', () => {
      assert.equal(readConfig(env).npmMirror, undefined);
    });

    it('needs all three', () => {
      for (const name of Object.keys(mirror)) {
        assert.throws(() => readConfig({ ...env, ...mirror, [name]: '' }), /must be set together/);
      }
    });

    it('rejects values that are not CodeArtifact names', () => {
      assert.throws(() => readConfig({ ...env, ...mirror, FACTORIAL_CODEARTIFACT_DOMAIN: 'Factorial' }), /DOMAIN is not/);
      assert.throws(() => readConfig({ ...env, ...mirror, FACTORIAL_CODEARTIFACT_DOMAIN_OWNER: '1234' }), /12-digit/);
      assert.throws(() => readConfig({ ...env, ...mirror, FACTORIAL_CODEARTIFACT_REPOSITORY: 'npm\n//evil/:_authToken=x' }), /REPOSITORY is not/);
      assert.throws(() => readConfig({ ...env, ...mirror, FACTORIAL_CODEARTIFACT_REPOSITORY: 'a/b' }), /REPOSITORY is not/);
    });
  });
});
