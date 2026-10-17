/**
 * Run deterministic shell commands inside a harness session, with no model
 * involved. The session is identified by the WorkItem id and must always be
 * addressed through the same endpoint qualifier as the agent invocation,
 * otherwise it is a different microVM.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand } from '@aws-sdk/client-bedrock-agentcore';

import { requireEnv } from './env.ts';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionTarget {
  harnessArn: string;
  qualifier: string;
  sessionId: string;
}

const client = new BedrockAgentCoreClient({});

export function sessionTarget(sessionId: string): SessionTarget {
  return {
    harnessArn: requireEnv('HARNESS_ARN'),
    qualifier: requireEnv('HARNESS_QUALIFIER'),
    sessionId,
  };
}

export async function runCommand(target: SessionTarget, command: string, timeoutSeconds = 300): Promise<CommandResult> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: target.harnessArn,
      qualifier: target.qualifier,
      runtimeSessionId: target.sessionId,
      body: { command, timeout: timeoutSeconds },
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
        throw new Error(`Session command failed (${key}): ${error.message ?? ''}`);
      }
    }
  }
  return { stdout, stderr, exitCode };
}

/** Run a command and throw with its output if it exits non-zero. */
export async function mustRun(target: SessionTarget, command: string, timeoutSeconds = 300): Promise<CommandResult> {
  const result = await runCommand(target, command, timeoutSeconds);
  if (result.exitCode !== 0) {
    throw new Error(`Session command exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-2000)}`);
  }
  return result;
}
