/**
 * pi (`@earendil-works/pi-coding-agent`) as the host's harness, for every
 * role since docs/pi-plan.md.
 *
 * pi runs its loop in the host process and brings no privilege drop,
 * subagents or limits of its own, so the host provides them:
 * - Every tool runs commands and file operations as the agent user
 *   (operations.ts). pi's grep starts `rg` from the host, so the image's `rg`
 *   is a wrapper that runs ripgrep as the agent user, and the host refuses to
 *   start pi unless that wrapper is the `rg` on its PATH. PI_OFFLINE stops pi
 *   downloading tools or checking for updates.
 * - Nothing is discovered: no extensions, skills, prompt templates, themes or
 *   context files from the workspace or a home directory, an in-memory session
 *   and a root-owned agent directory. Only the host's own inline extension
 *   loads.
 * - That extension applies the role's policy (roles.ts): tool_call asks it
 *   before each call, tool_result after each write or edit, and
 *   agent_before_settle before the run may end. It also enforces the turn
 *   limit; the budget is checked after each model call.
 * - Subagents are a `task` tool that runs a child session with the subagent's
 *   prompt, tools, model and turn limit, under the same policy. pi runs the
 *   tool calls in one response at once, so at most MAX_CONCURRENT_SUBAGENTS
 *   child sessions run together; a call beyond it waits.
 * The model is reached through pi's amazon-bedrock provider with the
 * execution role's credentials (bedrock.ts), in the version's region, and a
 * failed call is retried as patiently as Claude Code retried (PI_SETTINGS).
 */
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type, type AssistantMessage, type Model, type Api, type Provider } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { RunEnded, RunEvent } from '@factorial/run';

import { MAX_CONCURRENT_SUBAGENTS, type SubagentSpec } from '../agents.ts';
import type { Config } from '../config.ts';
import type { Harness } from '../harness.ts';
import type { HostRole, Note, RolePolicy } from '../roles.ts';
import type { RunRequest } from '../run.ts';
import type { ToolKind } from '../tools.ts';
import { signedGatewayCall, type GatewayCall } from '../web-search.ts';
import { SETPRIV, type AgentRunner } from './as-agent.ts';
import { shellEnvironment } from './environment.ts';
import { PiEvents, runStarted } from './events.ts';
import { bedrockProvider } from './bedrock.ts';
import { fetchTool } from './fetch.ts';
import type { Helper } from './operations.ts';
import { Slots } from './slots.ts';
import { taskDescription, taskResult } from './task.ts';
import { PI_TOOLS, toolCallOf, toolsFor, type AnyTool } from './tools.ts';

/** Where the host's message to the model is filed in pi's session. */
const HOST_MESSAGE = 'factorial-host';

/** The installed pi's version, read beside its entry point (its package exports no package.json). */
export function piVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    return (JSON.parse(readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** A queue that turns pushed events into an async iterable, ending when closed. */
class EventQueue<T> {
  private readonly items: T[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.waiting?.();
  }

  close(): void {
    this.closed = true;
    this.waiting?.();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = undefined;
    }
  }
}

/**
 * pi's settings for every session. pi retries a throttled or failed model call
 * 3 times by default, waiting 2, 4 and 8 seconds, where Claude Code retried 10
 * times: one burst of Bedrock throttling would end a pi run as model_error
 * where an SDK run carried on (#187). 10 retries, doubling from 2 seconds to pi's
 * 60-second cap, wait about six minutes in all, within the run's time limit.
 */
export const PI_SETTINGS = { retry: { enabled: true, maxRetries: 10, baseDelayMs: 2000, maxAgentDelayMs: 60_000 } } as const;

/** Why the host stopped the run before the model finished. */
type Stop = 'max_turns' | 'max_budget';

export interface PiParts {
  /** Runs commands as the agent user; SETPRIV on the Runtime. */
  runner: AgentRunner;
  helper: Helper;
  /** Where pi keeps its auth and settings files: root-owned, never the workspace or a home directory. */
  agentDir: string;
  webSearch: GatewayCall | undefined;
  /** The models' provider: Bedrock on the Runtime (bedrock.ts). */
  provider: Provider<Api>;
}

/** The image's ripgrep wrapper, which runs ripgrep as the agent user (agent-runtime/rg-as-agent). */
export const RG_WRAPPER = '/usr/local/bin/rg';

/** The first executable `name` on `pathVariable`, as a spawn would find it, or undefined. */
export function firstOnPath(name: string, pathVariable: string | undefined): string | undefined {
  for (const dir of (pathVariable ?? '').split(':').filter((d) => d.length > 0)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The parts the Runtime uses: setpriv to the agent user, the helper beside the bundle, state under the host's directory. */
export function runtimeParts(config: Config): PiParts {
  // pi's grep spawns `rg` as this root process: anything but the wrapper would search as root.
  const rg = firstOnPath('rg', process.env.PATH);
  if (rg !== RG_WRAPPER) throw new Error(`pi needs ${RG_WRAPPER} to be the rg on PATH, so ripgrep runs as the agent user; found ${rg ?? 'none'}`);
  const runner: AgentRunner = { prefix: SETPRIV, env: shellEnvironment(config, process.env) };
  const agentDir = path.join(config.stateDirectory, 'pi');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  return {
    runner,
    helper: { runner, command: ['node', '--no-warnings', fileURLToPath(new URL('./agent-ops.mjs', import.meta.url))], cwd: config.workspace },
    agentDir,
    webSearch: config.webSearchGatewayUrl ? signedGatewayCall(config.webSearchGatewayUrl, config.region) : undefined,
    provider: bedrockProvider(),
  };
}

export function piHarness(config: Config, role: HostRole, abortController: AbortController, parts: PiParts = runtimeParts(config)): Harness {
  process.env.PI_OFFLINE = '1';
  // pi's Bedrock client takes the region from here before its catalogue's endpoint (#181).
  process.env.AWS_REGION = config.region;
  const started = runStarted(config, role.tools.map((kind) => PI_TOOLS[kind]), piVersion());
  return {
    started,
    start: (request, note) => runPi(config, role, abortController, parts, started, request, note),
  };
}

interface SessionSpec {
  systemPrompt: string;
  tools: readonly ToolKind[];
  model: Model<Api>;
  /** The subagent, absent for the role's own loop. */
  agentType?: string;
  /** The main session's: send the model back before it ends. */
  beforeStop?: () => string | undefined;
  onTurn: () => void;
}

async function* runPi(
  config: Config,
  role: HostRole,
  abortController: AbortController,
  parts: PiParts,
  started: RunEvent,
  request: RunRequest,
  note: Note,
): AsyncGenerator<RunEvent> {
  yield started;
  const queue = new EventQueue<RunEvent>();
  const events = new PiEvents((event) => queue.push(event));
  const startedAt = Date.now();
  const policy: RolePolicy = role.session(config.workspace, note, PI_TOOLS);
  const runtime = await ModelRuntime.create({ authPath: path.join(parts.agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  // On the Runtime, Bedrock with the execution role's credentials (bedrock.ts).
  runtime.registerNativeProvider(parts.provider);
  const modelOf = (id: string): Model<Api> => {
    const model = runtime.getModel(parts.provider.id, id);
    if (!model) throw new Error(`pi's catalogue has no ${parts.provider.id} model ${id}`);
    return model;
  };
  const mainModel = modelOf(config.model);
  const background = modelOf(config.backgroundModel);
  const sessions = new Set<AgentSession>();
  let turns = 0;
  let stopped: Stop | undefined;
  const stop = (reason: Stop) => {
    if (stopped) return;
    stopped = reason;
    note('run stopped at its limit', { reason, turns, costUsd: events.costUsd });
    for (const session of sessions) void session.abort();
  };
  const checkBudget = () => {
    if (events.costUsd >= config.maxBudgetUsd) stop('max_budget');
  };
  const onAbort = () => {
    for (const session of sessions) void session.abort();
  };
  abortController.signal.addEventListener('abort', onAbort);

  const answer = (agentId?: string) => async (question: string): Promise<AssistantMessage> => {
    const reply = await runtime.completeSimple(background, { messages: [{ role: 'user', content: question, timestamp: Date.now() }] }, { maxTokens: 4096 });
    events.sideCall(reply, agentId);
    checkBudget();
    return reply;
  };

  const extension = (spec: SessionSpec): ExtensionFactory => (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = policy.decide(toolCallOf(event.toolName, event.input), spec.agentType);
      if (decision.allow) return undefined;
      events.deniedToolCalls += 1;
      note('tool use denied', { toolName: event.toolName, reason: decision.reason });
      return { block: true, reason: decision.reason };
    });
    pi.on('tool_result', async (event) => {
      const call = toolCallOf(event.toolName, event.input);
      if ((call.kind !== 'write' && call.kind !== 'edit') || !call.path || !policy.afterFileChange) return undefined;
      const message = policy.afterFileChange(call.path);
      return message === undefined ? undefined : { content: [...event.content, { type: 'text' as const, text: message }], isError: true };
    });
    pi.on('turn_end', async () => {
      spec.onTurn();
      return undefined;
    });
    if (spec.beforeStop) {
      const beforeStop = spec.beforeStop;
      pi.on('agent_before_settle', async (event) => {
        if (event.outcome !== 'completed' || stopped) return undefined;
        const reason = beforeStop();
        if (reason === undefined) return undefined;
        return { entries: [{ type: 'custom_message' as const, customType: HOST_MESSAGE, content: reason, display: false }], continue: true };
      });
    }
  };

  const createSession = async (spec: SessionSpec, extra: { agent?: AnyTool | undefined }, agentId?: string): Promise<AgentSession> => {
    const settingsManager = SettingsManager.inMemory(structuredClone(PI_SETTINGS));
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: parts.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: spec.systemPrompt,
      extensionFactories: [{ name: 'factorial', factory: extension(spec), hidden: true }],
    });
    await resourceLoader.reload();
    const customTools = toolsFor(spec.tools, {
      cwd: config.workspace,
      runner: parts.runner,
      helper: parts.helper,
      webSearch: parts.webSearch,
      fetch: fetchTool(parts.runner, config.workspace, answer(agentId)),
      agent: extra.agent,
    });
    const { session } = await createAgentSession({
      cwd: config.workspace,
      agentDir: parts.agentDir,
      modelRuntime: runtime,
      model: spec.model,
      ...(config.effort ? { thinkingLevel: config.effort } : {}),
      noTools: 'builtin',
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(config.workspace),
    });
    sessions.add(session);
    session.subscribe((event: AgentSessionEvent) => {
      events.session(event, agentId);
      if (event.type === 'message_end' && event.message.role === 'assistant') checkBudget();
    });
    return session;
  };

  /** The subagent tool: one child session per call, ending at its own turn limit, at most MAX_CONCURRENT_SUBAGENTS at once. */
  const subagentSlots = new Slots(MAX_CONCURRENT_SUBAGENTS);
  const taskTool = (subagents: Readonly<Record<string, SubagentSpec>>): AnyTool | undefined => {
    const names = Object.keys(subagents);
    if (names.length === 0) return undefined;
    return defineTool({
      name: PI_TOOLS.agent,
      label: 'subagent',
      description: taskDescription(subagents),
      parameters: Type.Object({
        subagent_type: Type.Union(names.map((name) => Type.Literal(name)), { description: 'Which subagent to run.' }),
        prompt: Type.String({ description: 'The complete brief: the subagent sees nothing else from your conversation.' }),
      }),
      execute: (toolCallId, params) => subagentSlots.run(async () => {
        // A call that waited for a slot while the run stopped starts nothing.
        if (stopped || abortController.signal.aborted) {
          return { content: [{ type: 'text' as const, text: 'The run has stopped; the subagent was not started.' }], details: undefined, isError: true };
        }
        const spec = subagents[params.subagent_type]!;
        queue.push({ type: 'subagent.started', agentId: toolCallId, agentType: params.subagent_type });
        const childStarted = Date.now();
        let childTurns = 0;
        let stoppedAtLimit: number | undefined;
        let toolCalls = 0;
        let child: AgentSession | undefined;
        try {
          child = await createSession(
            {
              systemPrompt: spec.prompt(PI_TOOLS),
              tools: spec.tools,
              model: spec.model === 'explore' && config.exploreModel ? modelOf(config.exploreModel) : mainModel,
              agentType: params.subagent_type,
              onTurn: () => {
                childTurns += 1;
                if (childTurns >= spec.maxTurns && stoppedAtLimit === undefined) {
                  stoppedAtLimit = spec.maxTurns;
                  void child?.abort();
                }
              },
            },
            {},
            toolCallId,
          );
          child.subscribe((event) => {
            if (event.type === 'tool_execution_start') toolCalls += 1;
          });
          await child.prompt(params.prompt);
          const reply = child.getLastAssistantText() ?? '';
          return { content: [{ type: 'text' as const, text: taskResult(params.subagent_type, reply, stoppedAtLimit) }], details: undefined };
        } finally {
          if (child) {
            sessions.delete(child);
            child.dispose();
          }
          queue.push({
            type: 'subagent.ended',
            agentId: toolCallId,
            agentType: params.subagent_type,
            durationMs: Date.now() - childStarted,
            toolCalls,
            finalContextTokens: events.lastInput.get(toolCallId) ?? 0,
          });
        }
      }),
    });
  };

  const tools: ToolKind[] = [...role.tools, ...(role.webSearch ? (['webSearch'] as const) : [])];
  const outcome = (async (): Promise<RunEnded> => {
    let main: AgentSession | undefined;
    try {
      main = await createSession(
        {
          systemPrompt: role.systemPrompt(PI_TOOLS),
          tools,
          model: mainModel,
          beforeStop: policy.beforeStop,
          onTurn: () => {
            // The call cut off by the stop ends a turn too; it is not one the run was allowed.
            if (stopped) return;
            turns += 1;
            if (turns >= config.maxTurns) stop('max_turns');
          },
        },
        { agent: taskTool(role.subagents) },
      );
      await main.prompt(policy.prompt(request.prompt));
      const last = [...main.messages].reverse().find((message) => message.role === 'assistant') as AssistantMessage | undefined;
      const figures = { turns, durationMs: Date.now() - startedAt };
      // No detail: the last message is the call the stop aborted, not how pi ended the run.
      if (stopped) return events.ended({ outcome: 'incomplete', reason: stopped, ...figures });
      if (abortController.signal.aborted) return events.ended({ outcome: 'failed', reason: 'harness_error', detail: 'aborted', ...figures });
      if (last?.stopReason === 'error') return events.ended({ outcome: 'failed', reason: 'model_error', detail: 'error', errors: [last.errorMessage ?? 'model error'], ...figures });
      return events.ended({ outcome: 'complete', reason: 'completed', ...(last?.stopReason ? { detail: last.stopReason } : {}), ...figures });
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
      main?.dispose();
    }
  })();
  outcome.then(
    (ended) => {
      queue.push(ended);
      queue.close();
    },
    () => queue.close(),
  );
  yield* queue.drain();
  // A failure outside the loop (no model in the catalogue, a session that
  // would not start) is the host's: Run records it as host_error.
  await outcome;
}
