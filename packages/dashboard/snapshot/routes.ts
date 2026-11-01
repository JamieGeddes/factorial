import { isFilter, matchesFilter, matchesSearch, type Filter } from '../src/lib/work-items.ts';
import { metricsKey, runKey, type SnapshotIndex, type SnapshotItem } from './format.ts';

/**
 * The static page's routing and its answers to the data routes, with no
 * browser in them so they can be tested.
 *
 * The page lives at one address and names its view in the hash, as a plain
 * name of letters, digits and hyphens (the hosts a snapshot is shared on
 * allow nothing else there): `#overview`, `#work-items`,
 * `#work-items-<id>`, `#runs`, `#run-<id>-<stage>-<round>`, `#metrics`,
 * `#health`. Query strings are not carried: a view keeps its filters in the
 * page.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_HASH = new RegExp(`^run-(${UUID})-([a-z]+)-(\\d+)$`);
const ITEM_HASH = new RegExp(`^work-items-(${UUID})$`);
const RUN_PATH = new RegExp(`^/runs/(${UUID})/([a-z]+)/(\\d+)$`);
const ITEM_PATH = new RegExp(`^/work-items/(${UUID})$`);

export type Route =
  | { kind: 'overview' }
  | { kind: 'work-items' }
  | { kind: 'work-item'; id: string }
  | { kind: 'runs' }
  | { kind: 'run'; id: string; stage: string; round: number }
  | { kind: 'metrics' }
  | { kind: 'health' }
  | { kind: 'missing'; path: string };

/** The hash name for an app path (`/runs/<id>/build/1` is `run-<id>-build-1`); an unknown path goes to the overview. */
export function hashOf(href: string): string {
  const path = href.split(/[?#]/)[0] ?? '/';
  if (path === '/' || path === '') return 'overview';
  if (path === '/work-items') return 'work-items';
  if (path === '/runs') return 'runs';
  if (path === '/metrics') return 'metrics';
  if (path === '/health') return 'health';
  const item = ITEM_PATH.exec(path);
  if (item) return `work-items-${item[1]}`;
  const run = RUN_PATH.exec(path);
  if (run) return `run-${run[1]}-${run[2]}-${run[3]}`;
  return 'overview';
}

/** The app path a hash names, `/` for none. */
export function pathOf(hash: string): string {
  const name = hash.replace(/^#/, '');
  if (name === '' || name === 'overview') return '/';
  if (['work-items', 'runs', 'metrics', 'health'].includes(name)) return `/${name}`;
  const item = ITEM_HASH.exec(name);
  if (item) return `/work-items/${item[1]}`;
  const run = RUN_HASH.exec(name);
  if (run) return `/runs/${run[1]}/${run[2]}/${run[3]}`;
  return `/${name}`;
}

export function routeOf(path: string): Route {
  if (path === '/') return { kind: 'overview' };
  if (path === '/work-items') return { kind: 'work-items' };
  if (path === '/runs') return { kind: 'runs' };
  if (path === '/metrics') return { kind: 'metrics' };
  if (path === '/health') return { kind: 'health' };
  const item = ITEM_PATH.exec(path);
  if (item) return { kind: 'work-item', id: item[1] as string };
  const run = RUN_PATH.exec(path);
  if (run) return { kind: 'run', id: run[1] as string, stage: run[2] as string, round: Number(run[3]) };
  return { kind: 'missing', path };
}

/** What the page answers a data route with: a body, or one of the snapshot's own files to read instead. */
export type Answer = { status: number; body: string; contentType: string } | { file: string };

const json = (body: unknown, status = 200): Answer => ({ status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8' });
const problem = (status: number, message: string): Answer => json({ error: message }, status);

/** The Work items route's answer, filtered as `workItemsPage` filters. */
export function workItemsAnswer(index: SnapshotIndex, params: URLSearchParams): Answer {
  const all = index.workItems.items;
  const asked = params.get('filter');
  const filter: Filter = isFilter(asked) ? asked : 'all';
  const source = params.get('source') ?? '';
  const q = params.get('q') ?? '';
  const matching = all.filter((item) => matchesFilter(item, filter) && (!source || item.source.type === source) && matchesSearch(item, q));
  const limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 100));
  const offset = Math.max(0, Number(params.get('cursor')) || 0);
  return json({
    ...index.workItems,
    items: matching.slice(offset, offset + limit),
    total: matching.length,
    ...(offset + limit < matching.length ? { nextCursor: String(offset + limit) } : {}),
  });
}

/**
 * The answer to a data route, or undefined when the URL is not one. `item`
 * reads a work item's file; it is asked only for ids the index names.
 */
export async function answer(url: URL, method: string, index: SnapshotIndex, item: (id: string) => Promise<SnapshotItem | undefined>): Promise<Answer | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/api/')) return undefined;
  if (method === 'POST') return path.startsWith('/api/live/') ? json({ channels: [] }) : problem(405, 'a snapshot answers only reads');
  if (path === '/api/status') return json(index.status);
  if (path === '/api/overview') return json(index.overview);
  if (path === '/api/running') return json(index.running);
  if (path === '/api/health') return json(index.health);
  if (path === '/api/metrics') {
    const found = index.metrics[metricsKey(url.searchParams.get('range') ?? '30', url.searchParams.get('repository') ?? '')];
    return found ? json(found) : problem(404, 'the snapshot holds no metrics for that range and repository');
  }
  if (path === '/api/work-items') return workItemsAnswer(index, url.searchParams);
  const run = RUN_PATH.exec(path.replace(/^\/api/, ''));
  if (run) {
    const found = (await item(run[1] as string))?.runs[runKey(run[2] as string, Number(run[3]))];
    return found ? json(found) : problem(404, 'no such run in the snapshot');
  }
  const rest = new RegExp(`^/api/work-items/(${UUID})(?:/artefacts/(.+))?$`).exec(path);
  if (!rest) return problem(404, 'not a route the snapshot holds');
  const loaded = await item(rest[1] as string);
  if (!loaded) return problem(404, 'no such work item in the snapshot');
  if (rest[2] === undefined) return json(loaded.detail);
  const entry = loaded.artefacts[rest[2].split('/').map(decodeURIComponent).join('/')];
  if (!entry) return problem(404, 'no such artefact in the snapshot');
  if (entry.kind === 'binary') return { status: 404, body: `This artefact is binary (${entry.size} bytes) and is not in the snapshot.`, contentType: 'text/plain; charset=utf-8' };
  if (entry.kind === 'file') return { file: entry.file };
  return { status: 200, body: entry.text, contentType: entry.contentType };
}
