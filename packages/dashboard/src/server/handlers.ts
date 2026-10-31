import 'server-only';

import { commitUrl, executionUrl, artefactsUrl, REGION } from '../lib/links.ts';
import { resultOf } from '../lib/status.ts';
import { compareItems, isFilter, matchesFilter, matchesSearch, sourceLabel, summarise, type Filter, type WorkItemSummary } from '../lib/work-items.ts';
import { isWorkItemId, itemKey } from './artefacts.ts';
import type { LiveMessage } from './live.ts';
import type { Services } from './services.ts';

/**
 * What each data route returns (#57): exactly what its view needs, so a
 * hosted API could later serve the same shapes. Every route reads; none
 * writes anything.
 */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const problem = (status: number, message: string): Response => json({ error: message }, status);

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const name = (error as { name?: string }).name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dashboard route failed: ${name}: ${message}`);
    const status = /CredentialsProviderError|ExpiredToken|UnrecognizedClient|AccessDenied/.test(name) ? 503 : 502;
    return problem(status, `${name}: ${message}`.slice(0, 300));
  }
}

export interface WorkItemsPage {
  items: WorkItemSummary[];
  total: number;
  /** Every source type the ledger holds, for the source filter. */
  sources: { type: string; label: string }[];
  /** Running (not in Test) and waiting (in Test) items, for the rail's count. */
  counts: { running: number; waiting: number };
  nextCursor?: string;
}

export async function workItemsPage(services: Services, query: { filter?: string | null; source?: string | null; q?: string | null; limit?: string | null; cursor?: string | null }): Promise<WorkItemsPage> {
  const [rows, threads] = await Promise.all([services.ledger.list(), services.threads.all()]);
  const now = services.now();
  const all = rows.map((row) => summarise(row, row.threadKey ? threads.get(row.threadKey) : undefined, now)).sort(compareItems);
  const filter: Filter = isFilter(query.filter) ? query.filter : 'all';
  const source = query.source ?? '';
  const matching = all.filter((item) => matchesFilter(item, filter) && (!source || item.source.type === source) && matchesSearch(item, query.q ?? ''));
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
  const offset = Math.max(0, Number(query.cursor) || 0);
  const items = matching.slice(offset, offset + limit);
  const types = [...new Set(all.map((item) => item.source.type))].sort();
  return {
    items,
    total: matching.length,
    sources: types.map((type) => ({ type, label: sourceLabel(type) })),
    counts: { running: all.filter((i) => i.running).length, waiting: all.filter((i) => i.waiting).length },
    ...(offset + limit < matching.length ? { nextCursor: String(offset + limit) } : {}),
  };
}

export function getWorkItems(request: Request, services: Services): Promise<Response> {
  return guarded(async () => {
    const params = new URL(request.url).searchParams;
    return json(
      await workItemsPage(services, {
        filter: params.get('filter'),
        source: params.get('source'),
        q: params.get('q'),
        limit: params.get('limit'),
        cursor: params.get('cursor'),
      }),
    );
  });
}

export async function workItemDetail(services: Services, id: string) {
  const row = await services.ledger.get(id);
  if (!row) return undefined;
  const [thread, objects, config] = await Promise.all([
    row.threadKey ? services.threads.get(row.threadKey) : Promise.resolve(undefined),
    services.artefacts.list(id),
    services.config(),
  ]);
  const execution = executionUrl(row.executionArn);
  const artefacts = artefactsUrl(config.bucket, row.artefactPrefix);
  return {
    row,
    thread: thread ?? null,
    summary: summarise(row, thread, services.now()),
    artefacts: objects,
    links: { ...(execution ? { execution } : {}), ...(artefacts ? { artefacts } : {}) },
  };
}

export function getWorkItem(services: Services, id: string): Promise<Response> {
  return guarded(async () => {
    if (!isWorkItemId(id)) return problem(400, 'not a work item id');
    const detail = await workItemDetail(services, id);
    return detail ? json(detail) : problem(404, 'no such work item');
  });
}

/** The content types an artefact is sent as: what it is, never anything a browser would run. */
export function safeContentType(key: string, stored: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'jsonl' || ext === 'ndjson') return 'application/x-ndjson; charset=utf-8';
  if (ext && ['md', 'txt', 'log', 'patch', 'diff', 'yml', 'yaml'].includes(ext)) return 'text/plain; charset=utf-8';
  const base = stored.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/json') return 'application/json; charset=utf-8';
  if (base === 'application/x-ndjson') return 'application/x-ndjson; charset=utf-8';
  if (base.startsWith('text/')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function getArtefact(services: Services, id: string, path: string[]): Promise<Response> {
  return guarded(async () => {
    const key = itemKey(id, path.map((p) => decodeURIComponent(p)).join('/'));
    if (!key) return problem(400, 'not a key under this work item');
    const row = await services.ledger.get(id);
    if (!row) return problem(404, 'no such work item');
    const content = await services.artefacts.get(key, resultOf(row) !== undefined);
    if (!content) return problem(404, 'no such artefact');
    return new Response(content.body as BodyInit, {
      headers: {
        'content-type': safeContentType(key, content.contentType),
        ...(content.size !== undefined ? { 'content-length': String(content.size) } : {}),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store',
      },
    });
  });
}

export function getRunning(services: Services): Promise<Response> {
  return guarded(async () => {
    const [rows, threads] = await Promise.all([services.ledger.running(), services.threads.all()]);
    const now = services.now();
    const items = rows
      .map((row) => ({ summary: summarise(row, row.threadKey ? threads.get(row.threadKey) : undefined, now), live: row.live ?? null }))
      .sort((a, b) => compareItems(a.summary, b.summary));
    return json({ items });
  });
}

const settle = async <T>(promise: Promise<T>): Promise<{ value?: T; error?: string }> => {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
};

/** Factorial's own repository, where `FactorialVersion` is a commit. */
export const FACTORIAL_REPOSITORY = 'JamieGeddes/factorial';

export interface StatusBar {
  version?: { sha: string; url?: string };
  runtimes: { name: string; role: string; version?: string }[];
  region: string;
  busRate?: number;
  alarms?: { total: number; firing: string[] };
  counts?: { running: number; waiting: number };
  errors: string[];
}

export async function statusBar(services: Services): Promise<StatusBar> {
  const [stack, runtimes, rate, alarms, running] = await Promise.all([
    settle(services.stacks.orchestration()),
    settle(services.runtimes.live()),
    settle(services.cloudwatch.busRate()),
    settle(services.cloudwatch.alarms()),
    settle(services.ledger.running()),
  ]);
  const sha = stack.value?.parameters.FactorialVersion;
  const [owner = '', name = ''] = (process.env.FACTORIAL_REPOSITORY ?? FACTORIAL_REPOSITORY).split('/');
  const url = sha ? commitUrl({ owner, name }, sha) : undefined;
  const rows = running.value?.map((row) => summarise(row, undefined, services.now()));
  return {
    ...(sha ? { version: { sha, ...(url ? { url } : {}) } } : {}),
    runtimes: runtimes.value ?? [],
    region: REGION,
    ...(rate.value !== undefined ? { busRate: rate.value } : {}),
    ...(alarms.value ? { alarms: alarms.value } : {}),
    ...(rows ? { counts: { running: rows.filter((r) => r.running).length, waiting: rows.filter((r) => r.waiting).length } } : {}),
    errors: [stack, runtimes, rate, alarms, running].flatMap((r) => (r.error ? [r.error] : [])),
  };
}

export function getStatus(services: Services): Promise<Response> {
  return guarded(async () => json(await statusBar(services)));
}

/** The live stream: server-sent events, one per tab, its channels set at the start and changed with `postLiveChannels`. */
export function getLive(request: Request, services: Services, heartbeatMs = 15_000): Response {
  const requested = (new URL(request.url).searchParams.get('channels') ?? '').split(',').filter(Boolean);
  const encoder = new TextEncoder();
  let close = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) throw new Error('stream closed');
        controller.enqueue(encoder.encode(text));
      };
      const stream = services.live.open({ send: (message: LiveMessage) => write(`data: ${JSON.stringify(message)}\n\n`) });
      const beat = setInterval(() => {
        try {
          write(': ping\n\n');
        } catch {
          close();
        }
      }, heartbeatMs);
      close = () => {
        if (!open) return;
        open = false;
        clearInterval(beat);
        stream.close();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      request.signal.addEventListener('abort', () => close());
      stream.setChannels(requested);
    },
    cancel() {
      close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}

export async function postLiveChannels(request: Request, services: Services, streamId: string): Promise<Response> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return problem(415, 'send JSON');
  const stream = services.live.stream(streamId);
  if (!stream) return problem(404, 'no such stream');
  let body: { channels?: unknown };
  try {
    body = (await request.json()) as { channels?: unknown };
  } catch {
    return problem(400, 'not JSON');
  }
  if (!Array.isArray(body.channels)) return problem(400, 'channels must be a list');
  return json({ channels: stream.setChannels(body.channels) });
}
