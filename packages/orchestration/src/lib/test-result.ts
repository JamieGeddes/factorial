/** `test/result.json`, from the test workflow's callback output, or saying why Test was skipped. */
export function testResultArtefact(result: { sha?: unknown; runUrl?: unknown; outcome?: unknown; skipped?: unknown }): {
  sha?: string;
  runId?: number;
  runUrl?: string;
  conclusion?: string;
  skipped?: string;
} {
  if (typeof result.skipped === 'string') return { skipped: result.skipped };
  const runUrl = typeof result.runUrl === 'string' ? result.runUrl : undefined;
  const runId = runUrl ? /\/actions\/runs\/([0-9]+)/.exec(runUrl)?.[1] : undefined;
  return {
    ...(typeof result.sha === 'string' ? { sha: result.sha } : {}),
    ...(runId ? { runId: Number(runId) } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(typeof result.outcome === 'string' ? { conclusion: result.outcome } : {}),
  };
}
