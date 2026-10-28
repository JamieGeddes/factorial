import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { PLAN_GATE_CLOSED } from '../report.ts';
import { HOST_ROLES, type RolePolicy } from '../roles.ts';
import { sdkHooks, toHookOutput } from './hooks.ts';
import { CLAUDE_TOOLS, toolCallOf } from './tools.ts';

const signal = new AbortController().signal;
const base = { tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' };
const pre = (tool_name: string, tool_input: unknown, extra: object = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...base, ...extra }) as unknown as HookInput;
const post = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, ...base }) as unknown as HookInput;
const stop = { hook_event_name: 'Stop', stop_hook_active: false, ...base } as unknown as HookInput;

describe('toolCallOf', () => {
  it("maps the SDK's file tools by their path field, the shell by its command, and the rest to other", () => {
    assert.deepEqual(toolCallOf('Write', { file_path: '/workspace/a' }), { kind: 'write', path: '/workspace/a' });
    assert.deepEqual(toolCallOf('Edit', { file_path: 'a' }), { kind: 'edit', path: 'a' });
    assert.deepEqual(toolCallOf('NotebookEdit', { notebook_path: '/tmp/n.ipynb' }), { kind: 'notebook', path: '/tmp/n.ipynb' });
    assert.deepEqual(toolCallOf('Write', {}), { kind: 'write', path: undefined });
    assert.deepEqual(toolCallOf('Bash', { command: 'git status' }), { kind: 'shell', command: 'git status' });
    assert.deepEqual(toolCallOf('Bash', null), { kind: 'shell', command: '' });
    assert.deepEqual(toolCallOf('Read', { file_path: '/etc/os-release' }), { kind: 'other', name: 'Read' });
  });
});

describe('toHookOutput', () => {
  it('denies with a reason the model can read, and allows with nothing', () => {
    const output = toHookOutput({ allow: false, reason: 'Do not push.' });
    assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.match(JSON.stringify(output), /"permissionDecision":"deny".*Do not push\./);
    assert.deepEqual(toHookOutput({ allow: true }), {});
  });
});

describe("sdkHooks on the builder's policy", () => {
  const builder = (workspace = '/workspace') => {
    const notes: string[] = [];
    const hooks = sdkHooks(HOST_ROLES.builder.session(workspace, (message) => notes.push(message), CLAUDE_TOOLS), (message) => notes.push(message));
    return { hooks, notes };
  };

  it("reads the subagent from agent_type only on a subagent's call", async () => {
    const { hooks } = builder();
    const hook = hooks.preToolUse[0]!.hooks[0]!;
    const write = pre('Write', { file_path: '/workspace/repo/a.ts' }, { agent_type: 'plan' });
    assert.match(JSON.stringify(await hook({ ...write, agent_id: 'a1' } as HookInput, undefined, { signal })), /"permissionDecision":"deny".*plan subagent/);
    assert.deepEqual(await hook(write, undefined, { signal }), {});
  });

  it('notes a denial and denies every tool once the plan gate has closed', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    writeFileSync(path.join(workspace, 'plan.json'), '{"steps":[]}');
    const { hooks, notes } = builder(workspace);
    const read = pre('Read', { file_path: path.join(workspace, 'repo/a.ts') });
    assert.deepEqual(await hooks.preToolUse[0]!.hooks[0]!(read, undefined, { signal }), {});
    const after = hooks.postToolUse[0]!;
    assert.equal(after.matcher, 'Write|Edit');
    const first = (await after.hooks[0]!(post('Write', { file_path: path.join(workspace, 'plan.json') }), undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(first.decision, 'block');
    assert.match(first.reason ?? '', /does not meet the plan contract/);
    const second = (await after.hooks[0]!(post('Edit', { file_path: 'plan.json' }), undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(second.reason, PLAN_GATE_CLOSED);
    assert.match(JSON.stringify(await hooks.preToolUse[0]!.hooks[0]!(read, undefined, { signal })), new RegExp(`"permissionDecision":"deny".*${PLAN_GATE_CLOSED.slice(0, 30)}`));
    assert.deepEqual(notes, ['plan invalid; builder sent back', 'plan invalid again; tools closed', 'tool use denied']);
  });

  it('ignores a write to another file after the tool, and lets the gate-closed run stop', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'workspace-'));
    const { hooks } = builder(workspace);
    assert.deepEqual(await hooks.postToolUse[0]!.hooks[0]!(post('Write', { file_path: path.join(workspace, 'notes.md') }), undefined, { signal }), {});
    const output = (await hooks.stop[0]!.hooks[0]!(stop, undefined, { signal })) as SyncHookJSONOutput;
    assert.equal(output.decision, 'block');
    assert.match(output.reason ?? '', /plan\.json is missing/);
    assert.deepEqual(await hooks.stop[0]!.hooks[0]!({ ...stop, hook_event_name: 'PreToolUse' } as HookInput, undefined, { signal }), {});
  });
});

describe("sdkHooks on the reviewer's policy", () => {
  it("applies the reviewer's rules, notes denials, and adds no PostToolUse hook", async () => {
    const notes: string[] = [];
    const hooks = sdkHooks(HOST_ROLES.reviewer.session('/workspace', () => {}, CLAUDE_TOOLS), (message) => notes.push(message));
    const hook = hooks.preToolUse[0]!.hooks[0]!;
    assert.match(JSON.stringify(await hook(pre('Write', { file_path: '/workspace/repo/a.ts' }), undefined, { signal })), /"permissionDecision":"deny".*review\.json.*with the Write tool/);
    assert.deepEqual(await hook(pre('Write', { file_path: '/workspace/review.json' }), undefined, { signal }), {});
    assert.deepEqual(notes, ['tool use denied']);
    assert.deepEqual(hooks.postToolUse, []);
  });

  it('blocks the stop with the policy reason', async () => {
    const policy: RolePolicy = { decide: () => ({ allow: true }), beforeStop: () => 'Write the review.', prompt: (p) => p };
    const output = (await sdkHooks(policy, () => {}).stop[0]!.hooks[0]!(stop, undefined, { signal })) as SyncHookJSONOutput;
    assert.deepEqual(output, { decision: 'block', reason: 'Write the review.' });
  });
});
