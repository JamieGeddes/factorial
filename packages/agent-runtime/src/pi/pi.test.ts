import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { validateRunEvent, type RunEvent } from '@factorial/run';

import { readConfig } from '../config.ts';
import { runAsAgent, type AgentRunner } from './as-agent.ts';
import { shellEnvironment } from './environment.ts';
import { PiEvents, runStarted, usageOf } from './events.ts';
import { pageText } from './fetch.ts';
import { bashOperations, editOperations, findOperations, grepFiles, readOperations, writeOperations, type Helper } from './operations.ts';
import { PI_TOOLS, toolCallOf, toolsFor } from './tools.ts';

const config = readConfig({
  FACTORIAL_ROLE: 'builder',
  FACTORIAL_HARNESS: 'pi',
  FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
  FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_BACKGROUND_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_MAX_TURNS: '150',
  FACTORIAL_RUN_CONTRACT: '1',
  FACTORIAL_MAX_BUDGET_USD: '5',
  FACTORIAL_MAX_DURATION_SECONDS: '6600',
  AWS_REGION: 'eu-west-1',
});

// Tests run as the current user: no privilege drop, the helper from source.
const runner: AgentRunner = { prefix: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
const helper = (cwd: string): Helper => ({ runner, command: [process.execPath, '--no-warnings', fileURLToPath(new URL('./agent-ops.ts', import.meta.url))], cwd });

describe('pi tools', () => {
  it("maps pi's tool calls to the rules' calls by their path and command", () => {
    assert.deepEqual(toolCallOf('write', { path: '/workspace/plan.json', content: '{}' }), { kind: 'write', path: '/workspace/plan.json' });
    assert.deepEqual(toolCallOf('edit', { path: 'a.ts', edits: [] }), { kind: 'edit', path: 'a.ts' });
    assert.deepEqual(toolCallOf('bash', { command: 'git push' }), { kind: 'shell', command: 'git push' });
    assert.deepEqual(toolCallOf('read', { path: '/etc/passwd' }), { kind: 'other', name: 'read' });
    assert.deepEqual(toolCallOf('write', {}), { kind: 'write', path: undefined });
  });

  it('builds the tools for each kind in order, leaving out search without a gateway', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-'));
    const names = toolsFor(['shell', 'read', 'edit', 'write', 'grep', 'glob', 'webSearch'], { cwd, runner, helper: helper(cwd), webSearch: undefined, fetch: undefined, agent: undefined }).map((t) => t.name);
    assert.deepEqual(names, ['bash', 'read', 'edit', 'write', 'grep', 'find']);
    const withSearch = toolsFor(['webSearch'], { cwd, runner, helper: helper(cwd), webSearch: async () => ({}), fetch: undefined, agent: undefined });
    assert.deepEqual(withSearch.map((t) => t.name), [PI_TOOLS.webSearch]);
  });
});

describe('runAsAgent and the operations', () => {
  it('runs a command with only the runner environment, streaming its output', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-'));
    const seen: string[] = [];
    const ops = bashOperations({ prefix: [], env: { PATH: process.env.PATH ?? '', ONLY: 'this' } });
    const result = await ops.exec('echo "$ONLY ${HOME:-nohome}"; exit 3', cwd, { onData: (d) => seen.push(d.toString()), env: { HOME: '/root', SECRET: 'x' } });
    assert.equal(result.exitCode, 3);
    assert.equal(seen.join('').trim(), 'this nohome');
  });

  it('prefixes every command with the drop', async () => {
    const result = await runAsAgent({ prefix: ['echo', 'dropped:'], env: { PATH: process.env.PATH ?? '' } }, ['bash', '-c', 'x'], { cwd: tmpdir() });
    assert.equal(result.stdout.toString().trim(), 'dropped: bash -c x');
  });

  it('reads, writes, edits and finds through the helper', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-'));
    const h = helper(cwd);
    await writeOperations(h).mkdir(path.join(cwd, 'src/deep'));
    await writeOperations(h).writeFile(path.join(cwd, 'src/deep/a.ts'), 'export const a = 1;\n');
    assert.equal((await readOperations(h).readFile(path.join(cwd, 'src/deep/a.ts'))).toString(), 'export const a = 1;\n');
    await editOperations(h).access(path.join(cwd, 'src/deep/a.ts'));
    await assert.rejects(readOperations(h).access(path.join(cwd, 'missing.ts')));
    mkdirSync(path.join(cwd, 'node_modules/x'), { recursive: true });
    writeFileSync(path.join(cwd, 'node_modules/x/b.ts'), '');
    assert.deepEqual(await findOperations(h).glob('**/*.ts', cwd, { ignore: [], limit: 10 }), ['src/deep/a.ts']);
    assert.equal(await findOperations(h).exists(path.join(cwd, 'src')), true);
  });

  it('greps file contents, skipping node_modules and binaries, and follows links with the rights of whoever runs it', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-'));
    writeFileSync(path.join(cwd, 'a.ts'), 'const VERSION = 1;\nconst other = 2;\n');
    writeFileSync(path.join(cwd, 'b.bin'), Buffer.from([0, 1, 2, 86, 69, 82]));
    mkdirSync(path.join(cwd, 'node_modules'));
    writeFileSync(path.join(cwd, 'node_modules/c.ts'), 'VERSION');
    const matches = await grepFiles(helper(cwd), cwd, 'version', { limit: 10, ignoreCase: true });
    assert.deepEqual(matches, [{ file: path.join(cwd, 'a.ts'), line: 1, text: 'const VERSION = 1;' }]);
    assert.deepEqual(await grepFiles(helper(cwd), cwd, 'VERSION', { limit: 10, ignoreCase: false, include: '*.md' }), []);
    symlinkSync('/etc/hosts', path.join(cwd, 'hosts.ts'));
    // The helper runs as the agent user on the Runtime; here it is the test user.
    assert.ok(Array.isArray(await grepFiles(helper(cwd), cwd, 'localhost', { limit: 1, ignoreCase: false })));
  });
});

describe('shellEnvironment', () => {
  it('passes the allow-list without the SDK settings, and sets the agent home and region', () => {
    const env = shellEnvironment(config, { PATH: '/usr/bin', AWS_SESSION_TOKEN: 't', ANTHROPIC_BEDROCK_BASE_URL: 'http://stub', GITHUB_TOKEN: 'never', HOME: '/root' });
    assert.deepEqual(env, { PATH: '/usr/bin', AWS_SESSION_TOKEN: 't', HOME: '/home/agent', AWS_REGION: 'eu-west-1' });
  });
});

describe('PiEvents', () => {
  const assistant = (extra: Partial<AssistantMessage> = {}): AssistantMessage =>
    ({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Look first.' },
        { type: 'text', text: 'Reading.' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
      ],
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      model: 'eu.anthropic.claude-sonnet-5-5',
      usage: { input: 4, output: 120, cacheRead: 9000, cacheWrite: 300, reasoning: 20, totalTokens: 9424, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } },
      stopReason: 'toolUse',
      timestamp: 0,
      ...extra,
    }) as AssistantMessage;

  function collect() {
    const events: RunEvent[] = [];
    return { events, pi: new PiEvents((event) => events.push(event)) };
  }

  it('maps a model call, its text, reasoning and tools to contract events', () => {
    const { events, pi } = collect();
    pi.session({ type: 'message_end', message: assistant() } as AgentSessionEvent);
    pi.session({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'a.ts' } } as AgentSessionEvent);
    pi.session({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: { content: [{ type: 'text', text: 'x' }] }, isError: false } as AgentSessionEvent);
    pi.session({ type: 'message_end', message: assistant({ content: [{ type: 'text', text: 'Plan written.' }] }) } as AgentSessionEvent, 'call_task');
    pi.session({ type: 'compaction_end', reason: 'threshold', result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 180000, estimatedTokensAfter: 20000 }, aborted: false, willRetry: false } as AgentSessionEvent);
    pi.session({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: 'throttled' } as AgentSessionEvent);
    for (const event of events) assert.ok(validateRunEvent(event).ok, JSON.stringify(event));
    assert.deepEqual(events.map((e) => e.type), ['model.call', 'reasoning', 'text', 'tool.call', 'tool.result', 'model.call', 'text', 'context.compacted', 'model.retry']);
    assert.deepEqual(events[0], {
      type: 'model.call',
      model: { provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' },
      usage: { inputTokens: 9304, outputTokens: 120, cacheReadInputTokens: 9000, cacheWriteInputTokens: 300, reasoningTokens: 20 },
      exact: true,
    });
    assert.equal((events[5] as { agentId?: string }).agentId, 'call_task');
    assert.equal(pi.lastInput.get('call_task'), 9304);
  });

  it('totals usage and cost per model into run.ended', () => {
    const { pi } = collect();
    pi.modelCall(assistant());
    pi.modelCall(assistant());
    pi.deniedToolCalls = 1;
    const ended = pi.ended({ outcome: 'incomplete', reason: 'max_turns', detail: 'toolUse', turns: 150, durationMs: 1000 });
    assert.ok(validateRunEvent(ended).ok);
    assert.equal(ended.cost?.usd, 0.0246);
    assert.deepEqual(ended.models?.[0]?.usage, { inputTokens: 18608, outputTokens: 240, cacheReadInputTokens: 18000, cacheWriteInputTokens: 600, reasoningTokens: 40 });
    assert.equal(ended.deniedToolCalls, 1);
  });

  it('names pi and the models by purpose in run.started', () => {
    const started = runStarted(config, ['bash', 'read'], '1.4.0');
    assert.ok(validateRunEvent(started).ok);
    assert.deepEqual(started.harness, { name: 'pi', version: '1.4.0' });
    assert.deepEqual(started.models.map((m) => m.purpose), ['main', 'explore', 'background']);
  });

  it('counts missing usage as zero', () => {
    assert.deepEqual(usageOf(undefined), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  });
});

describe('pageText', () => {
  it('drops scripts, styles and tags and keeps the text', () => {
    assert.equal(pageText('<html><style>a{}</style><script>x()</script><h1>Title</h1><p>One &amp; two</p></html>'), 'Title One & two');
  });
});

it('keeps the pi pin the same in the workspace and the image', () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']) {
    const workspace = read('../../package.json').dependencies[name];
    assert.match(workspace ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(read('../../../../agent-runtime/package.json').dependencies[name], workspace);
  }
});
