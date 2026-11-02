import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessageEventStream, type Message, type Provider } from '@earendil-works/pi-ai';
import type { RunEnded, RunEvent, SubagentStarted } from '@factorial/run';

import { MAX_CONCURRENT_SUBAGENTS, type SubagentSpec } from '../agents.ts';
import { readConfig } from '../config.ts';
import { SECOND_PASS } from '../review.ts';
import { HOST_ROLES, type HostRole } from '../roles.ts';
import type { AgentRunner } from './as-agent.ts';
import { piHarness, type PiParts } from './harness.ts';

const MODEL = 'global.anthropic.claude-sonnet-5-5';
const SMALL_MODEL = 'global.anthropic.claude-haiku-5-5';

const root = mkdtempSync(path.join(tmpdir(), 'pi-loop-'));
after(() => rmSync(root, { recursive: true, force: true }));

const configWith = (limits: { maxTurns?: number; maxBudgetUsd?: number }) => ({
  ...readConfig({
    FACTORIAL_ROLE: 'builder',
    FACTORIAL_MODEL: MODEL,
    FACTORIAL_EXPLORE_MODEL: SMALL_MODEL,
    FACTORIAL_BACKGROUND_MODEL: SMALL_MODEL,
    FACTORIAL_MAX_TURNS: String(limits.maxTurns ?? 150),
    FACTORIAL_RUN_CONTRACT: '1',
    FACTORIAL_MAX_BUDGET_USD: String(limits.maxBudgetUsd ?? 5),
    FACTORIAL_MAX_DURATION_SECONDS: '6600',
    AWS_REGION: 'eu-west-1',
  }),
  workspace: root,
  repository: root,
});

/** A role with the shell only, every call allowed and nothing to check before it ends. */
const role: HostRole = {
  systemPrompt: () => 'You are a test.',
  tools: ['shell'],
  gatewayTools: [],
  subagents: {},
  session: () => ({ decide: () => ({ allow: true }), beforeStop: () => undefined, prompt: (p) => p }),
};

// Tests run as the current user: no privilege drop.
const runner: AgentRunner = { prefix: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };

/** Each reply from `provider` priced at `costUsd`: pi's faux provider reports every call as free. */
function priced(provider: Provider, costUsd: number): Provider {
  const price = (source: AssistantMessageEventStream): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === 'done') event.message.usage.cost.total = costUsd;
        out.push(event);
      }
      out.end();
    })();
    return out;
  };
  return {
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    getModels: () => provider.getModels(),
    stream: (model, context, options) => price(provider.stream(model, context, options)),
    streamSimple: (model, context, options) => price(provider.streamSimple(model, context, options)),
  };
}

/** A model that runs `true` in the shell on every call and never ends by itself, at `costUsd` a call; `onCall` sees each call's number. */
function busyModel(costUsd = 0, onCall: (call: number) => void = () => {}) {
  const faux = fauxProvider({ provider: 'amazon-bedrock', models: [{ id: MODEL }, { id: SMALL_MODEL }] });
  faux.setResponses(
    Array.from({ length: 50 }, () => (_context: unknown, _options: unknown, state: { callCount: number }) => {
      onCall(state.callCount);
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'true' }), { stopReason: 'toolUse' });
    }),
  );
  return { provider: priced(faux.provider, costUsd), state: faux.state };
}

async function run(
  limits: { maxTurns?: number; maxBudgetUsd?: number },
  faux: ReturnType<typeof busyModel>,
  abortController = new AbortController(),
): Promise<{ ended: RunEnded; calls: number }> {
  const config = configWith(limits);
  const parts: PiParts = {
    runner,
    helper: { runner, command: ['false'], cwd: root },
    agentDir: mkdtempSync(path.join(root, 'agent-')),
    webSearch: undefined,
    awsDocs: undefined,
    provider: faux.provider,
  };
  const harness = piHarness(config, role, abortController, parts);
  const events: RunEvent[] = [];
  for await (const event of harness.start({ prompt: 'Work.', round: 1 }, () => undefined)) events.push(event);
  const ended = events.find((event): event is RunEnded => event.type === 'run.ended');
  assert.ok(ended, 'the run ends');
  return { ended, calls: faux.state.callCount };
}

describe("pi's loop at its limits", () => {
  it('stops at the turn limit, reporting the turns it allowed', async () => {
    const { ended } = await run({ maxTurns: 3 }, busyModel());
    assert.equal(ended.outcome, 'incomplete');
    assert.equal(ended.reason, 'max_turns');
    assert.equal(ended.turns, 3);
    assert.equal(ended.detail, undefined);
  });

  it('stops at the budget, after the call that reached it', async () => {
    const { ended, calls } = await run({ maxBudgetUsd: 1 }, busyModel(0.4));
    assert.equal(ended.outcome, 'incomplete');
    assert.equal(ended.reason, 'max_budget');
    assert.equal(calls, 3);
    assert.equal(ended.detail, undefined);
  });

  it('ends aborted when the host aborts it, which run.ts reports as the duration limit', async () => {
    const abortController = new AbortController();
    const { ended, calls } = await run({}, busyModel(0, (call) => call === 2 && abortController.abort()), abortController);
    assert.equal(ended.outcome, 'failed');
    assert.equal(ended.reason, 'harness_error');
    assert.equal(ended.detail, 'aborted');
    assert.ok(calls < 5, `stopped after ${calls} calls`);
  });
});

describe("the reviewer's role on pi", () => {
  it('sends the reviewer back until review.json is valid, then once for a second pass, then lets it end', async () => {
    const workspace = mkdtempSync(path.join(root, 'review-'));
    const review = JSON.stringify({
      schemaVersion: 1,
      verdict: 'approve',
      scores: { correctness: 5, completeness: 5, tests: 4, safety: 5 },
      findings: [],
      summary: 'Does what was asked.',
    });
    const write = (content: string) => fauxAssistantMessage(fauxToolCall('write', { path: `${workspace}/review.json`, content }), { stopReason: 'toolUse' });
    const done = () => fauxAssistantMessage('Done.', { stopReason: 'stop' });
    const faux = fauxProvider({ provider: 'amazon-bedrock', models: [{ id: MODEL }, { id: SMALL_MODEL }] });
    faux.setResponses([write('{}'), done(), write(review), done(), done()]);
    const config = {
      ...readConfig({
        FACTORIAL_ROLE: 'reviewer',
        FACTORIAL_MODEL: MODEL,
        FACTORIAL_BACKGROUND_MODEL: SMALL_MODEL,
        FACTORIAL_MAX_TURNS: '60',
        FACTORIAL_RUN_CONTRACT: '1',
        FACTORIAL_MAX_BUDGET_USD: '2',
        FACTORIAL_MAX_DURATION_SECONDS: '900',
        AWS_REGION: 'eu-west-1',
      }),
      workspace,
    };
    const parts: PiParts = {
      runner,
      helper: { runner, command: [process.execPath, '--no-warnings', fileURLToPath(new URL('./agent-ops.ts', import.meta.url))], cwd: workspace },
      agentDir: mkdtempSync(path.join(root, 'agent-')),
      webSearch: undefined,
      awsDocs: undefined,
      provider: faux.provider,
    };
    const sentBack: string[] = [];
    const events: RunEvent[] = [];
    const note = (message: string, fields: Record<string, unknown>) => message === 'reviewer sent back' && sentBack.push(String(fields.reason));
    for await (const event of piHarness(config, HOST_ROLES.reviewer, new AbortController(), parts).start({ prompt: 'Review.', round: 1 }, note)) events.push(event);
    const ended = events.find((event): event is RunEnded => event.type === 'run.ended');
    assert.equal(ended?.outcome, 'complete');
    assert.equal(sentBack.length, 2);
    assert.match(sentBack[0] ?? '', /review\.json/);
    assert.equal(sentBack[1], SECOND_PASS);
    assert.equal(readFileSync(path.join(workspace, 'review.json'), 'utf8'), review);
    assert.equal(faux.state.callCount, 5);
  });
});

describe('subagents that start subagents (#277)', () => {
  const spec = (name: string, subagents?: Record<string, SubagentSpec>): SubagentSpec => ({
    description: `The ${name} subagent.`,
    prompt: () => `[${name}]`,
    tools: ['agent'],
    model: 'inherit',
    maxTurns: 10,
    ...(subagents ? { subagents } : {}),
  });
  // leaf names a subagent of its own, which it must not get when another subagent starts it.
  const plain = spec('plain');
  const leaf = spec('leaf', { plain });
  const parent = spec('parent', { leaf });
  const nestingRole: HostRole = { ...role, tools: ['agent'], subagents: { parent, plain } };

  const textOf = (message: Message | undefined) =>
    !message ? '' : typeof message.content === 'string' ? message.content : message.content.map((block) => ('text' in block ? block.text : '')).join('');
  /** Which session a call comes from, by the marker its prompt carries. */
  const sessionOf = (messages: Message[]) =>
    /\[(root|parent|leaf|plain)\]/.exec(messages.flatMap((m) => (m.role === 'system' ? [textOf(m), ...Object.values(m.sections ?? {})] : [])).join('\n'))?.[1] ?? 'unknown';
  /** The subagents the session's task tool offers, or undefined when it has none. */
  const offeredOf = (messages: Message[]): string[] | undefined => {
    const task = messages.flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : [])).find((tool) => tool.name === 'task');
    if (!task) return undefined;
    const type = (task.parameters as { properties: { subagent_type: { const?: string; anyOf?: { const: string }[] } } }).properties.subagent_type;
    return type.anyOf ? type.anyOf.map((option) => option.const) : [type.const ?? ''];
  };

  /**
   * A model that, in the root session, starts `rootCalls` subagents at once and
   * in each parent `leafCalls` leaves at once, then ends each session; every
   * call outside the root takes `delayMs`, and the peak of those in flight is kept.
   */
  function nestingModel(rootCalls: string[], leafCalls: number, delayMs = 0) {
    const faux = fauxProvider({ provider: 'amazon-bedrock', models: [{ id: MODEL }, { id: SMALL_MODEL }] });
    const offered = new Map<string, string[] | undefined>();
    let ids = 0;
    let inFlight = 0;
    const seen = { peak: 0 };
    const call = (type: string) => fauxToolCall('task', { subagent_type: type, prompt: `Do the ${type} work.` }, { id: `toolu_${(ids += 1)}` });
    const respond = async (context: { messages: Message[] }) => {
      const session = sessionOf(context.messages);
      offered.set(session, offeredOf(context.messages));
      const answered = context.messages.some((m) => m.role === 'toolResult');
      if (session === 'root') return answered ? fauxAssistantMessage('Root done.') : fauxAssistantMessage(rootCalls.map(call), { stopReason: 'toolUse' });
      inFlight += 1;
      seen.peak = Math.max(seen.peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      if (session === 'parent' && !answered) return fauxAssistantMessage(Array.from({ length: leafCalls }, () => call('leaf')), { stopReason: 'toolUse' });
      return fauxAssistantMessage(`${session} done.`);
    };
    faux.setResponses(Array.from({ length: 500 }, () => respond));
    return { provider: faux.provider, state: faux.state, offered, seen };
  }

  async function runNesting(model: ReturnType<typeof nestingModel>): Promise<RunEvent[]> {
    const parts: PiParts = { runner, helper: { runner, command: ['false'], cwd: root }, agentDir: mkdtempSync(path.join(root, 'agent-')), webSearch: undefined, awsDocs: undefined, provider: model.provider };
    const events: RunEvent[] = [];
    const nestedRole: HostRole = { ...nestingRole, systemPrompt: () => '[root]' };
    for await (const event of piHarness(configWith({}), nestedRole, new AbortController(), parts).start({ prompt: 'Work.', round: 1 }, () => undefined)) events.push(event);
    assert.equal(events.find((event): event is RunEnded => event.type === 'run.ended')?.outcome, 'complete');
    return events;
  }

  it('gives a subagent declared with subagents a task tool offering exactly those, one declared without none, and a nested one none', async () => {
    const model = nestingModel(['parent', 'plain'], 1);
    await runNesting(model);
    assert.deepEqual(model.offered.get('root'), ['parent', 'plain']);
    assert.deepEqual(model.offered.get('parent'), ['leaf']);
    assert.equal(model.offered.get('plain'), undefined);
    assert.equal(model.offered.get('leaf'), undefined, 'leaf names plain, but a nested subagent starts none');
  });

  it("names the parent on a nested subagent's events, and its model calls carry its own agent id", async () => {
    const events = await runNesting(nestingModel(['parent'], 1));
    const started = events.filter((event): event is SubagentStarted => event.type === 'subagent.started');
    const parentRun = started.find((event) => event.agentType === 'parent');
    const leafRun = started.find((event) => event.agentType === 'leaf');
    assert.ok(parentRun && leafRun);
    assert.equal(parentRun.parentAgentId, undefined);
    assert.equal(leafRun.parentAgentId, parentRun.agentId);
    const leafEnded = events.find((event) => event.type === 'subagent.ended' && event.agentType === 'leaf');
    assert.equal(leafEnded && 'parentAgentId' in leafEnded ? leafEnded.parentAgentId : undefined, parentRun.agentId);
    assert.equal(events.filter((event) => event.type === 'model.call' && event.agentId === leafRun.agentId).length, 1);
  });

  it('keeps the concurrency cap across root and nested calls, and parents holding every slot still finish', async () => {
    const model = nestingModel(Array.from({ length: MAX_CONCURRENT_SUBAGENTS + 2 }, () => 'parent'), 3, 15);
    const events = await runNesting(model);
    assert.equal(events.filter((event) => event.type === 'subagent.ended' && event.agentType === 'leaf').length, (MAX_CONCURRENT_SUBAGENTS + 2) * 3);
    assert.equal(model.seen.peak, MAX_CONCURRENT_SUBAGENTS);
  });
});
