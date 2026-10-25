import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

import { decideToolUse, preToolUseHooks, toHookOutput } from './hooks.ts';
import { PLAN_GATE_CLOSED } from './report.ts';

const allowed = (tool: string, input: unknown) => decideToolUse('/workspace', tool, input).allow;

describe('decideToolUse', () => {
  it('allows file writes inside the workspace', () => {
    assert.equal(allowed('Write', { file_path: '/workspace/repo/src/a.ts' }), true);
    assert.equal(allowed('Edit', { file_path: '/workspace/notes.md' }), true);
    assert.equal(allowed('Write', { file_path: 'repo/relative.ts' }), true);
  });

  it('denies file writes outside the workspace or into host-owned directories', () => {
    assert.equal(allowed('Write', { file_path: '/etc/profile' }), false);
    assert.equal(allowed('Edit', { file_path: '/workspace/../opt/factorial/agent-runtime/host.mjs' }), false);
    assert.equal(allowed('Write', { file_path: '/workspace-other/x' }), false);
    assert.equal(allowed('NotebookEdit', { notebook_path: '/tmp/n.ipynb' }), false);
    assert.equal(allowed('Edit', { file_path: '/workspace/.claude/settings.json' }), false);
    assert.equal(allowed('Write', {}), false);
  });

  it('denies pushing and calling GitHub from the shell', () => {
    assert.equal(allowed('Bash', { command: 'git push origin HEAD' }), false);
    assert.equal(allowed('Bash', { command: 'cd repo && git -C . push --force' }), false);
    assert.equal(allowed('Bash', { command: 'gh api repos/x/y' }), false);
    assert.equal(allowed('Bash', { command: 'gh auth status' }), false);
  });

  it('allows ordinary shell commands and reads', () => {
    assert.equal(allowed('Bash', { command: 'git commit -m "Add the push notification"' }), true);
    assert.equal(allowed('Bash', { command: 'quiet npm test' }), true);
    assert.equal(allowed('Read', { file_path: '/etc/os-release' }), true);
  });

  it('gives the model a reason it can read', () => {
    const output = toHookOutput(decideToolUse('/workspace', 'Bash', { command: 'git push' }));
    assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.match(JSON.stringify(output), /"permissionDecision":"deny".*orchestrator pushes/);
    assert.deepEqual(toHookOutput({ allow: true }), {});
  });
});

describe('decideToolUse for the plan subagent', () => {
  const plan = (tool: string, file: string) => decideToolUse('/workspace', tool, { file_path: file }, 'plan');

  it('lets it write only the two plan files', () => {
    assert.equal(plan('Write', '/workspace/plan.json').allow, true);
    assert.equal(plan('Write', '/workspace/plan.md').allow, true);
    assert.equal(plan('Write', 'plan.json').allow, true);
    for (const file of ['/workspace/notes.md', '/workspace/repo/plan.json', '/workspace/plan.json.bak', '/workspace/repo/../plan.md/x']) {
      assert.equal(plan('Write', file).allow, false, file);
    }
  });

  it('refuses it Edit and NotebookEdit, even on the plan files', () => {
    assert.equal(plan('Edit', '/workspace/plan.json').allow, false);
    assert.equal(decideToolUse('/workspace', 'NotebookEdit', { notebook_path: '/workspace/plan.md' }, 'plan').allow, false);
  });

  it('leaves the builder and the explore subagent to the general rules', () => {
    assert.equal(decideToolUse('/workspace', 'Write', { file_path: '/workspace/repo/a.ts' }).allow, true);
    assert.equal(decideToolUse('/workspace', 'Write', { file_path: '/workspace/repo/a.ts' }, 'explore').allow, true);
  });
});

describe('preToolUseHooks', () => {
  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/workspace/repo/a.ts' }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' } as unknown as HookInput;
  const signal = new AbortController().signal;

  it("reads the subagent from agent_type only on a subagent's call", async () => {
    const [matcher] = preToolUseHooks('/workspace', () => {});
    const write = { ...read, tool_name: 'Write', tool_input: { file_path: '/workspace/repo/a.ts' }, agent_type: 'plan' } as unknown as HookInput;
    assert.match(JSON.stringify(await matcher!.hooks[0]!({ ...write, agent_id: 'a1' } as HookInput, undefined, { signal })), /"permissionDecision":"deny".*plan subagent/);
    assert.deepEqual(await matcher!.hooks[0]!(write, undefined, { signal }), {});
  });

  it('denies every tool once the plan gate has closed', async () => {
    let closed = false;
    const denied: string[] = [];
    const [matcher] = preToolUseHooks('/workspace', (tool) => denied.push(tool), () => closed);
    assert.deepEqual(await matcher!.hooks[0]!(read, undefined, { signal }), {});
    closed = true;
    assert.match(JSON.stringify(await matcher!.hooks[0]!(read, undefined, { signal })), new RegExp(`"permissionDecision":"deny".*${PLAN_GATE_CLOSED.slice(0, 30)}`));
    assert.deepEqual(denied, ['Read']);
  });
});
