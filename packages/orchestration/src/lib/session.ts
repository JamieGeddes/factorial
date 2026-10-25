/**
 * Run deterministic shell commands inside an agent's session, with no model
 * involved. The session is identified by the WorkItem id and must always be
 * addressed through the same endpoint qualifier as the agent invocation,
 * otherwise it is a different microVM. Commands run as root. On the builder's
 * Runtime the model runs as the `agent` user, so the workspace is handed to
 * it after seeding and git runs as it once the model has had the repository.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand } from '@aws-sdk/client-bedrock-agentcore';

import { redactSecrets } from '@factorial/artefacts';

import { requireEnv } from './env.ts';
import { shellQuote } from './shell.ts';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionTarget {
  /** The harness or Runtime ARN. */
  arn: string;
  qualifier: string;
  sessionId: string;
  /** A harness's agent runs as root; Factorial's Runtime host runs it as `agent`. */
  kind: 'harness' | 'runtime';
}

const client = new BedrockAgentCoreClient({});

/** Each agent role is its own runtime, so the same session id names a different session per role. */
export type SessionRole = 'builder' | 'planner' | 'reviewer';

const HARNESS_ARN_ENV: Record<Exclude<SessionRole, 'builder'>, string> = {
  planner: 'PLANNER_HARNESS_ARN',
  reviewer: 'REVIEWER_HARNESS_ARN',
};

/**
 * The builder, and its clean room, run on Factorial's host on
 * BUILDER_RUNTIME_ARN; the planner and reviewer on their harnesses. Both
 * kinds are addressed through the `live` qualifier.
 */
export function sessionTarget(sessionId: string, role: SessionRole = 'builder'): SessionTarget {
  const qualifier = requireEnv('HARNESS_QUALIFIER');
  if (role === 'builder') return { arn: requireEnv('BUILDER_RUNTIME_ARN'), qualifier, sessionId, kind: 'runtime' };
  return { arn: requireEnv(HARNESS_ARN_ENV[role]), qualifier, sessionId, kind: 'harness' };
}

/** The user the Runtime host runs the model as, and its home. */
const AGENT_USER = 'agent';
const AGENT_HOME = '/home/agent';

/**
 * A script to run as the user the model runs as, so that root never runs git
 * or reads files in a workspace the model controls: whatever the model
 * planted there acts with no more than its own privileges. The same drop as
 * the host's `claude-as-agent` wrapper. On a harness the model is root, and
 * the script runs unchanged.
 */
export function asAgent(target: SessionTarget, script: string): string {
  if (target.kind === 'harness') return script;
  return [
    `exec setpriv --reuid=${AGENT_USER} --regid=${AGENT_USER} --init-groups --no-new-privs --bounding-set=-all -- \\`,
    `  env HOME=${AGENT_HOME} bash -c ${shellQuote(script)}`,
  ].join('\n');
}

/**
 * Give the seeded workspace to the user the model runs as. The seeding
 * commands run as root, and the session is new, so nothing the model left can
 * be in the tree yet. Call it after the last seeding write.
 */
export async function handOverWorkspace(target: SessionTarget): Promise<void> {
  if (target.kind === 'harness') return;
  await mustRun(target, `chown -R ${AGENT_USER}:${AGENT_USER} /workspace`, 120);
}

/**
 * The command string to send. A harness runs it through a shell. A Runtime
 * splits it into words as a shell would, honouring quotes, but runs the first
 * word as a program, so `set -e` or a pipeline fails unless bash is named.
 */
export function commandFor(target: SessionTarget, script: string): string {
  return target.kind === 'runtime' ? `bash -c ${shellQuote(script)}` : script;
}

export async function runCommand(target: SessionTarget, command: string, timeoutSeconds = 300): Promise<CommandResult> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: target.arn,
      qualifier: target.qualifier,
      runtimeSessionId: target.sessionId,
      body: { command: commandFor(target, command), timeout: timeoutSeconds },
    }),
  );

  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  for await (const event of response.stream ?? []) {
    if (event.chunk?.contentDelta) {
      stdout += event.chunk.contentDelta.stdout ?? '';
      stderr += event.chunk.contentDelta.stderr ?? '';
    }
    if (event.chunk?.contentStop) {
      exitCode = event.chunk.contentStop.exitCode ?? -1;
    }
    for (const key of ['accessDeniedException', 'internalServerException', 'resourceNotFoundException', 'runtimeClientError', 'throttlingException', 'validationException'] as const) {
      const error = event[key];
      if (error) {
        throw new Error(`Session command failed (${key}): ${redactSecrets(error.message ?? '')}`);
      }
    }
  }
  return { stdout, stderr, exitCode };
}

/** Run a command and throw with its (redacted) output if it exits non-zero. */
export async function mustRun(target: SessionTarget, command: string, timeoutSeconds = 300): Promise<CommandResult> {
  const result = await runCommand(target, command, timeoutSeconds);
  if (result.exitCode !== 0) {
    throw new Error(`Session command exited ${result.exitCode}: ${redactSecrets((result.stderr || result.stdout).slice(-2000))}`);
  }
  return result;
}

/**
 * A second, pristine session for operations that need credentials. It shares
 * nothing with the agent's session: no files, no git configuration, no hooks,
 * no background processes. Same qualifier, different session id. No model
 * ever runs in it, so on the Runtime it stays root's.
 */
export function cleanRoomTarget(workItemId: string): SessionTarget {
  return sessionTarget(`${workItemId}-push`);
}
