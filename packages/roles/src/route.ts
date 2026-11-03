/**
 * The route a builder session runs on (#169), as the orchestrator seeds it
 * and the host reads it. The request carries only the prompt, so the route
 * reaches the host as a file in the seed, read once as the run starts and
 * before the model has run: `change` builds as always, `propose` plans and
 * changes nothing, and the host's policy closes every tool once the plan is
 * valid. A session seeded without the file is `change`.
 */
export const ROUTE_FILE = 'route.json';

export const SESSION_ROUTES = ['change', 'propose'] as const;
export type SessionRoute = (typeof SESSION_ROUTES)[number];

/** The file's content for a route. */
export function routeFileContent(route: SessionRoute): string {
  return `${JSON.stringify({ route })}\n`;
}

/** The route a route file names: `change` when the file is absent, unreadable or names anything else. */
export function parseRouteFile(text: string | undefined): SessionRoute {
  if (text === undefined) return 'change';
  try {
    const parsed: unknown = JSON.parse(text);
    const route = typeof parsed === 'object' && parsed !== null ? (parsed as { route?: unknown }).route : undefined;
    return route === 'propose' ? 'propose' : 'change';
  } catch {
    return 'change';
  }
}
