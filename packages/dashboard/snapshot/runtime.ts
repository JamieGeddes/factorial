import { SNAPSHOT_FORMAT, type SnapshotIndex, type SnapshotItem } from './format.ts';
import { answer } from './routes.ts';

/**
 * What stands in for the server in the static page: `fetch` answers the data
 * routes from the snapshot, `EventSource` is a stream that says it is a
 * snapshot and sends nothing, and the history is left alone (the views write
 * their filters into the address with `replaceState`, which the hosts a
 * snapshot is shared on do not allow; the hash is the only address here).
 */
export interface Snapshot {
  index: SnapshotIndex;
  item(id: string): Promise<SnapshotItem | undefined>;
  /** A snapshot file's URL, relative to the page. */
  url(file: string): URL;
}

/**
 * The snapshot's files as `build.ts` embeds them in the page: a gzipped JSON
 * map of path to text, base64 in a script element. Returns a `fetch` that
 * serves them, so the page needs no server and opens from disk.
 */
export async function embeddedFetch(element: { textContent: string | null }, base: string): Promise<typeof fetch> {
  const text = element.textContent?.trim() ?? '';
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot decompress the embedded data (it has no DecompressionStream; Chrome 80, Firefox 113, Safari 16.4 or later can)');
  const unpacked = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const files = JSON.parse(unpacked) as Record<string, string>;
  const root = new URL('.', base).href;
  return async (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, base);
    const key = decodeURIComponent(url.href.startsWith(root) ? url.href.slice(root.length) : url.pathname.replace(/^\//, ''));
    const body = files[key];
    if (body === undefined) return new Response(`no such file in the snapshot: ${key}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const type = key.endsWith('.json') ? 'application/json; charset=utf-8' : key.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8';
    return new Response(body, { status: 200, headers: { 'content-type': type, 'content-length': String(new TextEncoder().encode(body).byteLength) } });
  };
}

export async function loadSnapshot(realFetch: typeof fetch, base: string): Promise<Snapshot> {
  const url = (file: string) => new URL(file, base);
  const response = await realFetch(url('data/snapshot.json'));
  if (!response.ok) throw new Error(`data/snapshot.json: HTTP ${response.status}`);
  const index = (await response.json()) as SnapshotIndex;
  if (index.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot format ${String(index.format)} is not ${SNAPSHOT_FORMAT}`);
  const items = new Map<string, Promise<SnapshotItem | undefined>>();
  return {
    index,
    url,
    item(id) {
      const file = index.items[id]?.file;
      if (!file) return Promise.resolve(undefined);
      let pending = items.get(id);
      if (!pending) {
        pending = realFetch(url(file)).then(async (r) => (r.ok ? ((await r.json()) as SnapshotItem) : undefined));
        pending.catch(() => items.delete(id));
        items.set(id, pending);
      }
      return pending;
    },
  };
}

class SnapshotEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
      for (const message of [{ kind: 'hello', stream: 'snapshot' }, { kind: 'state', state: 'snapshot', channels: {} }]) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      }
    }, 0);
  }
  close(): void {
    this.readyState = 2;
  }
}

/** Puts the snapshot behind `fetch` and `EventSource`; returns what it replaced, for tests. */
export function install(snapshot: Snapshot, target: { fetch: typeof fetch; EventSource: unknown; history: { pushState: unknown; replaceState: unknown } }): { fetch: typeof fetch } {
  const real = target.fetch.bind(target);
  target.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, snapshot.url('index.html'));
    const found = await answer(url, (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase(), snapshot.index, snapshot.item);
    if (!found) return real(input, init);
    if ('file' in found) return real(snapshot.url(found.file), init?.signal ? { signal: init.signal } : undefined);
    return new Response(found.body, { status: found.status, headers: { 'content-type': found.contentType, 'content-length': String(new TextEncoder().encode(found.body).byteLength) } });
  };
  target.EventSource = SnapshotEventSource;
  target.history.pushState = () => {};
  target.history.replaceState = () => {};
  return { fetch: real };
}
