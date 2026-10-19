/** `test/result.json`, from the test workflow's callback output. */
export function testResultArtefact(result: { sha?: unknown; runUrl?: unknown; outcome?: unknown }): {
  sha?: string;
  runId?: number;
  runUrl?: string;
  conclusion?: string;
} {
  const runUrl = typeof result.runUrl === 'string' ? result.runUrl : undefined;
  const runId = runUrl ? /\/actions\/runs\/([0-9]+)/.exec(runUrl)?.[1] : undefined;
  return {
    ...(typeof result.sha === 'string' ? { sha: result.sha } : {}),
    ...(runId ? { runId: Number(runId) } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(typeof result.outcome === 'string' ? { conclusion: result.outcome } : {}),
  };
}
