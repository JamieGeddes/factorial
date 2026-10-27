import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { readConfig } from './config.ts';
import { queryOptions } from './options.ts';
import { BUILDER_TOOLS, HOST_ROLES, REVIEWER_TOOLS } from './roles.ts';
import { reviewerPrompt } from './prompts/reviewer.ts';
import { TOOL_NAME, webSearchServer } from './web-search.ts';

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

const parts = {
  hostEnv: {},
  preToolUse: [],
  postToolUse: [],
  stop: [],
  abortController: new AbortController(),
  stderr: () => {},
};

describe('queryOptions', () => {
  it('fixes the model, limits and tools from the configuration and reads nothing from disk', () => {
    const options = queryOptions(config, HOST_ROLES.builder, { ...parts, webSearch: undefined });
    assert.equal(options.model, 'eu.anthropic.claude-sonnet-5-5');
    assert.equal(options.cwd, '/workspace');
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.equal(options.maxTurns, 150);
    assert.equal(options.maxBudgetUsd, 10);
    assert.deepEqual(options.tools, BUILDER_TOOLS);
    assert.ok(BUILDER_TOOLS.includes('WebFetch'));
    assert.deepEqual(Object.keys(options.agents ?? {}), ['explore', 'plan']);
    assert.deepEqual(Object.keys(options.hooks ?? {}), ['PreToolUse', 'PostToolUse', 'Stop']);
    assert.deepEqual(options.agents?.explore?.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(options.agents?.explore?.model, 'eu.anthropic.claude-haiku-5-5');
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.pathToClaudeCodeExecutable, '/opt/factorial/agent-runtime/claude-as-agent');
  });

  it('offers web search only when the gateway is configured', () => {
    const options = queryOptions(config, HOST_ROLES.builder, { ...parts, webSearch: webSearchServer(async () => ({})) });
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ['factorial']);
    assert.deepEqual(options.allowedTools, [TOOL_NAME]);
    assert.ok(options.agents?.plan?.tools?.includes(TOOL_NAME));
  });
});

describe('queryOptions for the reviewer', () => {
  const reviewer = { ...config, role: 'reviewer' as const, exploreModel: undefined };

  it('gives it its own prompt and read-only tools, and no subagents', () => {
    const options = queryOptions(reviewer, HOST_ROLES.reviewer, { ...parts, webSearch: undefined });
    assert.equal(options.systemPrompt, reviewerPrompt);
    assert.deepEqual(options.tools, REVIEWER_TOOLS);
    assert.ok(!REVIEWER_TOOLS.includes('Agent') && !REVIEWER_TOOLS.includes('WebFetch'));
    assert.deepEqual(options.agents, {});
    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.deepEqual(options.settingSources, []);
  });

  it('never offers it web search', () => {
    const options = queryOptions(reviewer, HOST_ROLES.reviewer, { ...parts, webSearch: webSearchServer(async () => ({})) });
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.allowedTools, []);
  });
});

describe('the SDK pin', () => {
  it('is the same exact version in the workspace and the image', () => {
    const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    const workspace = read('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'];
    const image = read('../../../agent-runtime/package.json').dependencies['@anthropic-ai/claude-agent-sdk'];
    assert.match(workspace, /^\d+\.\d+\.\d+$/);
    assert.equal(image, workspace);
  });
});
