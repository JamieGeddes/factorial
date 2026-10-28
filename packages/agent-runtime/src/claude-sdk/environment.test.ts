import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConfig } from '../config.ts';
import { agentEnvironment } from './environment.ts';

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

describe('agentEnvironment', () => {
  it('passes through only allow-listed variables', () => {
    const env = agentEnvironment(config, {
      PATH: '/usr/bin',
      HOME: '/root',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
      FACTORIAL_WEB_SEARCH_GATEWAY_URL: 'https://gateway.example/mcp',
      GITHUB_TOKEN: 'ghs_secret',
      NODE_OPTIONS: '--require /tmp/x.js',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/agent');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/workspace/.claude');
    assert.equal(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, 'http://169.254.170.23/v1/credentials');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.FACTORIAL_WEB_SEARCH_GATEWAY_URL, undefined);
  });

  it('routes to Bedrock with the version model and turns off non-essential behaviour', () => {
    const env = agentEnvironment(config, { ANTHROPIC_MODEL: 'something-else' });
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(env.AWS_REGION, 'eu-west-1');
    assert.equal(env.ANTHROPIC_MODEL, 'eu.anthropic.claude-sonnet-5-5');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'eu.anthropic.claude-haiku-5-5');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, '1');
    assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
    assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '4');
  });

  it('runs subagents and commands in the foreground, with room for long checks', () => {
    const env = agentEnvironment(config, {});
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '600000');
  });
});
