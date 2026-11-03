/**
 * The invoker's verify mode (#167): run one of a target's declared checks in
 * a fresh session on the verifier Runtime and wait for it, however long it
 * takes, as the agent mode waits for a run. PrepareVerify has already put the
 * tested commit in the session (from a bundle: no token is in it) and handed
 * the workspace to the agent user.
 *
 * The check runs through the session command API, inside the session, never
 * in this container, so this task's role is out of its reach; the image's
 * check runner drops to the agent user (packages/agent-runtime/src/verifier/).
 * Its output streams back here; the end of it is kept, redacted, as
 * `verify/<name>/output.log`, and the result as `verify/<name>/result.json`
 * (contracts/verifiers/v1/). Then the session is stopped: nothing is read out
 * of it. A task stopped by the state's timeout records `timed-out`.
 *
 * The task exits 0 once the result is stored, whatever the outcome:
 * CollectVerifier judges it. It touches no ledger row and records no progress.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';

import { artefactKey, putArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { createLogger } from '@factorial/log';
import { verifierPath, type VerifierOutcome } from '@factorial/verifiers';

import { OutputTail, checkCommand, commandTimeoutSeconds, outcomeOf, verifierResult, verifyTask } from './verifier.ts';

const task = verifyTask(process.env);
const { target, verifier } = task;
const log = createLogger(`verify/${verifier.name}`, { workItemId: task.workItemId });
// The command's own timeout ends it; this only guards against a stream that never closes.
const client = new BedrockAgentCoreClient({ requestHandler: { requestTimeout: 2 * 60 * 60 * 1000 } });
const output = new OutputTail();
const startedAt = new Date();

let stored: Promise<boolean> | undefined;

/** Store the log and the result once, whichever way the check ends, then stop the session. */
function finish(outcome: VerifierOutcome, exitCode: number | undefined, detail?: string): Promise<boolean> {
  stored ??= (async () => {
    const finishedAt = new Date();
    let ok = true;
    let logRecord: { key: string; bytes: number; truncated: boolean } | undefined;
    try {
      const path = verifierPath(verifier.name, 'output.log');
      await putArtefact(task.artefactPrefix, path, output.text(), 'text/plain; charset=utf-8');
      logRecord = { key: artefactKey(task.artefactPrefix, path), bytes: output.bytes, truncated: output.truncated };
    } catch (error) {
      log.error('log not stored', { error });
    }
    const result = verifierResult({ task, outcome, ...(exitCode !== undefined ? { exitCode } : {}), ...(detail ? { detail } : {}), startedAt, finishedAt, ...(logRecord ? { log: logRecord } : {}) });
    try {
      await putJsonArtefact(task.artefactPrefix, verifierPath(verifier.name, 'result.json'), result);
    } catch (error) {
      ok = false;
      log.error('result not stored', { error });
    }
    log.info('verifier finished', { outcome, exitCode, durationSeconds: result.durationSeconds, outputBytes: output.bytes });
    try {
      await client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: target.runtimeArn, qualifier: target.qualifier, runtimeSessionId: target.sessionId }));
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== 'ResourceNotFoundException') log.error('session not stopped', { error });
    }
    return ok;
  })();
  return stored;
}

// The state's timeout (or a person) stops the task with SIGTERM before SIGKILL.
process.once('SIGTERM', () => {
  log.error('invoker stopped before the check ended');
  void finish('timed-out', undefined, 'the stage timed out before the check ended').finally(() => process.exit(1));
});

async function main(): Promise<number> {
  log.info('running verifier', { sessionId: target.sessionId, sha: task.sha, timeoutSeconds: verifier.timeoutSeconds, required: verifier.required });
  let exitCode = -1;
  try {
    const response = await client.send(
      new InvokeAgentRuntimeCommandCommand({
        agentRuntimeArn: target.runtimeArn,
        qualifier: target.qualifier,
        runtimeSessionId: target.sessionId,
        body: { command: checkCommand(verifier), timeout: commandTimeoutSeconds(verifier) },
      }),
    );
    for await (const event of response.stream ?? []) {
      if (event.chunk?.contentDelta) {
        if (event.chunk.contentDelta.stdout) output.add(event.chunk.contentDelta.stdout);
        if (event.chunk.contentDelta.stderr) output.add(event.chunk.contentDelta.stderr);
      }
      if (event.chunk?.contentStop) exitCode = event.chunk.contentStop.exitCode ?? -1;
      for (const key of ['accessDeniedException', 'internalServerException', 'resourceNotFoundException', 'runtimeClientError', 'throttlingException', 'validationException'] as const) {
        const error = event[key];
        if (error) throw new Error(`session command failed (${key}): ${redactSecrets(error.message ?? '')}`);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error('verifier could not be run', { error: detail });
    return (await finish('error', undefined, redactSecrets(detail))) ? 0 : 1;
  }
  const elapsed = (Date.now() - startedAt.getTime()) / 1000;
  const { outcome, detail } = outcomeOf(exitCode, elapsed, verifier.timeoutSeconds);
  return (await finish(outcome, exitCode, detail)) ? 0 : 1;
}

// Exit at once: open sockets in the SDK client would otherwise keep the task running.
process.exit(await main());
