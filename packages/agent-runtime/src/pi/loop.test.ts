import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessageEventStream, type Provider } from '@earendil-works/pi-ai';
import type { RunEnded, RunEvent } from '@factorial/run';

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
});

/** A role with the shell only, every call allowed and nothing to check before it ends. */
const role: HostRole = {
  systemPrompt: () => 'You are a test.',
  tools: ['shell'],
  webSearch: false,
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
