import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPLORE, PLAN } from '../agents.ts';
import type { ToolNames } from '../tools.ts';
import { builderPrompt } from './builder.ts';
import { reviewerPrompt } from './reviewer.ts';

/** Names no harness uses, so any Claude Code name left in a prompt shows. */
const OTHER: ToolNames = {
  shell: 'x_shell',
  read: 'x_read',
  edit: 'x_edit',
  write: 'x_write',
  grep: 'x_grep',
  glob: 'x_glob',
  fetch: 'x_fetch',
  agent: 'x_agent',
  webSearch: 'x_web_search',
};

describe('prompts on another harness', () => {
  const prompts = {
    builder: builderPrompt(OTHER),
    plan: PLAN.prompt(OTHER),
    explore: EXPLORE.prompt(OTHER),
    reviewer: reviewerPrompt(OTHER),
  };

  it("name no Claude Code tool, only the harness's", () => {
    for (const [name, text] of Object.entries(prompts)) {
      assert.doesNotMatch(text, /\b(?:Bash|Grep|Glob|WebFetch|NotebookEdit)\b|\bAgent tool\b|\bWrite (?:and Edit|call|only)\b/, name);
      assert.match(text, /\bx_(?:read|grep|glob)\b/, name);
    }
    assert.match(prompts.builder, /x_shell, x_read, x_edit, x_write, x_grep and x_glob, the web_search tool, x_fetch, and two subagents through the x_agent tool/);
  });
});
