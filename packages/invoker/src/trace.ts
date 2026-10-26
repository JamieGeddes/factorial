/**
 * Trace correlation. The W3C `baggage` header on InvokeAgentRuntime carries
 * the session id and the run's key, so the run's spans can be found by the
 * work item id once AgentCore observability is exported.
 */
export function traceBaggage(sessionId: string, workItemId: string, attempt: number | undefined): string {
  const entries: Array<[string, string | number | undefined]> = [
    ['session.id', sessionId],
    ['factorial.workItemId', workItemId],
    ['factorial.attempt', attempt],
  ];
  return entries
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join(',');
}
