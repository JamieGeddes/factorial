/**
 * Types and validation for the run contract: what a role's Runtime host
 * streams to the invoker and answers to its status call. The host owns the
 * harness (pi today) and the model; the invoker reads only
 * this, so a different harness or a model from another provider changes the
 * host and nothing downstream.
 *
 * The canonical contract is the JSON Schema in `contracts/run/v1/`. The types
 * here mirror it for convenience; validation always runs against the schema
 * files, so the schema wins if the two ever disagree.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import eventSchema from '../../../contracts/run/v1/run-event.schema.json' with { type: 'json' };
import invocationSchema from '../../../contracts/run/v1/invocation.schema.json' with { type: 'json' };
import statusSchema from '../../../contracts/run/v1/run-status.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Contract version implemented by this package: the `contract` of a run request, run.started and the status reply. */
export const RUN_CONTRACT = 1 as const;

/** The Runtime version's environment variable declaring the contract its host speaks. */
export const RUN_CONTRACT_VARIABLE = 'FACTORIAL_RUN_CONTRACT';

export const RUN_OUTCOMES = ['complete', 'incomplete', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * The reasons Factorial knows. The contract leaves `reason` open so a new
 * harness can add one; consumers decide by the outcome, never by an unknown
 * reason.
 */
export const RUN_REASONS = {
  completed: 'complete',
  max_turns: 'incomplete',
  max_budget: 'incomplete',
  max_duration: 'incomplete',
  model_error: 'failed',
  harness_error: 'failed',
  host_error: 'failed',
} as const satisfies Record<string, RunOutcome>;
export type KnownRunReason = keyof typeof RUN_REASONS;

/** A model as the provider names it; `provider` is how it is reached (bedrock, anthropic, openai, ...). */
export interface ModelRef {
  provider?: string;
  id: string;
}

/** inputTokens is the whole prompt, cache reads and writes included; the rest are subsets, absent when not reported. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
}

export interface RunStarted {
  type: 'run.started';
  contract: typeof RUN_CONTRACT;
  harness: { name: string; version?: string };
  role: string;
  models: (ModelRef & { purpose: string })[];
  tools?: string[];
}

export interface ModelCall {
  type: 'model.call';
  agentId?: string;
  model?: ModelRef;
  usage: TokenUsage;
  /** False when outputTokens is a lower bound. */
  exact?: boolean;
  /** Milliseconds from the request to the end of the response, as the harness measured it (#59). */
  durationMs?: number;
  /** The harness's estimate for this call at list prices (#194). */
  cost?: { usd: number };
}

export interface ModelRetry {
  type: 'model.retry';
  attempt: number;
  maxRetries?: number;
  delayMs?: number;
  status?: number | null;
  error?: string;
}

export interface TextEvent {
  type: 'text' | 'reasoning';
  agentId?: string;
  model?: ModelRef;
  text: string;
}

export interface ToolCall {
  type: 'tool.call';
  agentId?: string;
  callId: string;
  tool: string;
  input: unknown;
}

export interface ToolResult {
  type: 'tool.result';
  agentId?: string;
  callId: string;
  isError?: boolean;
  content: string;
}

export interface SubagentStarted {
  type: 'subagent.started';
  agentId: string;
  agentType: string;
  parentAgentId?: string;
}

export interface SubagentEnded {
  type: 'subagent.ended';
  agentId: string;
  agentType: string;
  durationMs?: number;
  toolCalls?: number;
  finalContextTokens?: number;
}

export interface ContextCompacted {
  type: 'context.compacted';
  agentId?: string;
  trigger: 'auto' | 'manual';
  tokensBefore?: number;
  tokensAfter?: number;
}

/** A harness message no other event carries, kept for the transcript and never interpreted. */
export interface HarnessNative {
  type: 'harness';
  name: string;
  message: unknown;
}

export interface ModelTotal {
  model: ModelRef;
  usage: TokenUsage;
  costUsd?: number;
}

export interface RunEnded {
  type: 'run.ended';
  outcome: RunOutcome;
  reason: string;
  /** The harness's own code for the ending. */
  detail?: string;
  errors?: string[];
  turns?: number;
  durationMs?: number;
  cost?: { usd: number; basis: 'harness-estimate' };
  /** The run's totals per model, subagents included. */
  models?: ModelTotal[];
  deniedToolCalls?: number;
}

export type RunEvent =
  | RunStarted
  | ModelCall
  | ModelRetry
  | TextEvent
  | ToolCall
  | ToolResult
  | SubagentStarted
  | SubagentEnded
  | ContextCompacted
  | HarnessNative
  | RunEnded;

export type RunState = 'idle' | 'running' | 'finished' | 'failed';

export interface RunStatus {
  contract: typeof RUN_CONTRACT;
  state: RunState;
  events: number;
  ended?: RunEnded;
}

export interface RunRequest {
  action: 'run';
  contract: typeof RUN_CONTRACT;
  prompt: string;
  round: number;
  workItemId?: string;
  attempt?: number;
}

export type Invocation = RunRequest | { action: 'attach'; after?: number } | { action: 'status' };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(eventSchema);
const validateEventSchema = ajv.compile<RunEvent>(eventSchema);
const validateStatusSchema = ajv.compile<RunStatus>(statusSchema);
const validateInvocationSchema = ajv.compile<Invocation>(invocationSchema);

function describe(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  return `${path} ${error.message ?? error.keyword}`;
}

function validator<T>(validate: ((input: unknown) => boolean) & { errors?: ErrorObject[] | null }) {
  return (input: unknown): ValidationResult<T> => {
    if (validate(input)) return { ok: true, value: input as T };
    // `if` failures only repeat the `then` error they lead to.
    return { ok: false, errors: (validate.errors ?? []).filter((e) => e.keyword !== 'if').map(describe) };
  };
}

/** Validate one streamed event. Unknown event types pass with only the envelope checked. */
export const validateRunEvent = validator<RunEvent>(validateEventSchema);

export const validateRunStatus = validator<RunStatus>(validateStatusSchema);

export const validateInvocation = validator<Invocation>(validateInvocationSchema);

/** The outcome a known reason implies, or undefined for a reason this version does not know. */
export function outcomeOfReason(reason: string): RunOutcome | undefined {
  return Object.hasOwn(RUN_REASONS, reason) ? RUN_REASONS[reason as KnownRunReason] : undefined;
}
