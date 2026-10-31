import '../src/app/globals.css';
import './snapshot.css';

import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { LiveProvider } from '../src/client/live.tsx';
import { NowProvider } from '../src/client/now.tsx';
import { StatusProvider } from '../src/client/status.tsx';
import { TooltipProvider } from '../src/components/charts/Tooltip.tsx';
import { HealthView } from '../src/components/health/HealthView.tsx';
import { MetricsView } from '../src/components/metrics/MetricsView.tsx';
import { OverviewView } from '../src/components/overview/OverviewView.tsx';
import { RunView } from '../src/components/run/RunView.tsx';
import { RunsView } from '../src/components/run/RunsView.tsx';
import { Rail } from '../src/components/shell/Rail.tsx';
import { TopBar } from '../src/components/shell/TopBar.tsx';
import { WorkItemDetail } from '../src/components/work-items/WorkItemDetail.tsx';
import { WorkItemsView } from '../src/components/work-items/WorkItemsView.tsx';
import { fmtBytes } from '../src/lib/transcript.ts';
import { text } from '../src/lib/sanitise.ts';
import { metricsKey, runKey, type SnapshotItem } from './format.ts';
import { routeOf, type Route } from './routes.ts';
import { embeddedFetch, install, loadSnapshot, type Snapshot } from './runtime.ts';
import { usePathname } from './shims/navigation.ts';

/**
 * The command centre as a static page: the same shell and views as the app,
 * reading a snapshot (`capture.ts`) through the stand-ins in `runtime.ts`.
 */
const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

function Banner({ snapshot }: { snapshot: Snapshot }) {
  const { index } = snapshot;
  const items = index.workItems.total;
  return (
    <div className="snapshot-banner" role="note">
      <span>
        <b>Snapshot</b> of the Factorial command centre, taken <b>{WHEN.format(new Date(index.capturedAtMs))}</b>.
      </span>
      <span>
        <span className="num">{items}</span> work items and <span className="num">{index.runCount}</span> agent runs, with their transcripts and artefacts. Every figure is as it was then; nothing updates.
      </span>
      {index.redacted.length ? <span>{`Replaced before sharing: ${index.redacted.join(', ')}.`}</span> : null}
    </div>
  );
}

function useItem(snapshot: Snapshot, id: string): { item?: SnapshotItem; missing: boolean } {
  const [state, setState] = useState<{ id: string; item?: SnapshotItem; missing: boolean }>({ id, missing: false });
  useEffect(() => {
    let stale = false;
    void snapshot.item(id).then((item) => {
      if (!stale) setState({ id, ...(item ? { item } : {}), missing: !item });
    });
    return () => {
      stale = true;
    };
  }, [snapshot, id]);
  return state.id === id ? state : { missing: false };
}

function Missing({ what }: { what: string }) {
  return (
    <section>
      <div className="view-head">
        <h1>Not in the snapshot</h1>
      </div>
      <p className="note">{what}</p>
    </section>
  );
}

function Loading() {
  return <div className="snapshot-loading">Reading from the snapshot…</div>;
}

function ItemView({ snapshot, id }: { snapshot: Snapshot; id: string }) {
  const { item, missing } = useItem(snapshot, id);
  if (missing) return <Missing what={`The snapshot holds no work item ${id}.`} />;
  if (!item) return <Loading />;
  return <WorkItemDetail detail={item.detail} />;
}

function RunRoute({ snapshot, id, stage, round }: { snapshot: Snapshot; id: string; stage: string; round: number }) {
  const { item, missing } = useItem(snapshot, id);
  if (missing) return <Missing what={`The snapshot holds no work item ${id}.`} />;
  if (!item) return <Loading />;
  const detail = item.runs[runKey(stage, round)];
  if (!detail) return <Missing what={`The snapshot holds no ${stage}/${round} run of ${id}.`} />;
  return <RunView key={detail.channel} initial={detail} />;
}

function View({ snapshot, route }: { snapshot: Snapshot; route: Route }) {
  const { index } = snapshot;
  switch (route.kind) {
    case 'overview':
      return <OverviewView initial={index.overview} />;
    case 'work-items':
      return <WorkItemsView initial={index.workItems} initialQuery={{ filter: 'all', source: '', q: '' }} />;
    case 'work-item':
      return <ItemView snapshot={snapshot} id={route.id} />;
    case 'runs':
      return <RunsView items={index.runs} />;
    case 'run':
      return <RunRoute snapshot={snapshot} id={route.id} stage={route.stage} round={route.round} />;
    case 'metrics': {
      const initial = index.metrics[metricsKey(30, '')];
      return initial ? <MetricsView initial={initial} /> : <Missing what="The snapshot holds no metrics." />;
    }
    case 'health':
      return <HealthView initial={index.health} />;
    default:
      return <Missing what={`Nothing is at ${route.path}.`} />;
  }
}

const VIEWER_CAP = 1_000_000;

/**
 * Artefact links open here instead of a new tab: the live app serves them
 * from its own route, which the static page answers from the snapshot.
 */
function ArtefactViewer() {
  const [shown, setShown] = useState<{ path: string; body: string; size: number } | undefined>();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest?.('a');
      const href = anchor?.getAttribute('href');
      if (!href?.startsWith('/api/work-items/')) return;
      event.preventDefault();
      const path = decodeURIComponent(href.replace(/^\/api\/work-items\/[^/]+\/artefacts\//, ''));
      void fetch(href)
        .then(async (r) => {
          const body = await r.text();
          setShown({ path, body: body.length > VIEWER_CAP ? body.slice(0, VIEWER_CAP) : body, size: body.length });
        })
        .catch((e: unknown) => setShown({ path, body: `Could not read this artefact: ${e instanceof Error ? e.message : String(e)}`, size: 0 }));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  useEffect(() => {
    const dialog = document.getElementById('artefact-viewer') as HTMLDialogElement | null;
    if (!dialog) return;
    if (shown && !dialog.open) dialog.showModal();
    if (!shown && dialog.open) dialog.close();
  }, [shown]);
  return (
    <dialog id="artefact-viewer" className="artefact-viewer" onClose={() => setShown(undefined)} aria-label="Artefact">
      {shown ? (
        <>
          <div className="head">
            <span className="mono">{text(shown.path)}</span>
            {shown.size > VIEWER_CAP ? <span className="note" style={{ margin: 0 }}>{`showing the first ${fmtBytes(VIEWER_CAP)} of ${fmtBytes(shown.size)}`}</span> : null}
            <button type="button" className="btn" onClick={() => setShown(undefined)}>
              Close
            </button>
          </div>
          <pre>{text(shown.body)}</pre>
        </>
      ) : null}
    </dialog>
  );
}

function App({ snapshot }: { snapshot: Snapshot }) {
  const route = routeOf(usePathname());
  return (
    <NowProvider frozenAt={snapshot.index.capturedAtMs}>
      <StatusProvider initial={snapshot.index.status}>
        <LiveProvider>
          <TooltipProvider>
            <div className="shell">
              <Rail />
              <TopBar />
              <main id="main">
                <Banner snapshot={snapshot} />
                <View snapshot={snapshot} route={route} />
              </main>
            </div>
            <ArtefactViewer />
          </TooltipProvider>
        </LiveProvider>
      </StatusProvider>
    </NowProvider>
  );
}

function Failed({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <main id="main" style={{ gridColumn: '1 / -1' }}>
        <section>
          <div className="view-head">
            <h1>Factorial command centre snapshot</h1>
          </div>
          <div className="error-note" role="alert">
            {children}
          </div>
        </section>
      </main>
    </div>
  );
}

async function main(): Promise<void> {
  const root = createRoot(document.getElementById('root') as HTMLElement);
  try {
    const embedded = document.getElementById('snapshot-data');
    const snapshot = await loadSnapshot(embedded ? await embeddedFetch(embedded, document.baseURI) : window.fetch.bind(window), document.baseURI);
    install(snapshot, window as unknown as Parameters<typeof install>[1]);
    document.title = `Factorial Command Centre, snapshot of ${snapshot.index.capturedAt.slice(0, 10)}`;
    root.render(
      <StrictMode>
        <App snapshot={snapshot} />
      </StrictMode>,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(<Failed>{`Could not read the snapshot's data: ${message}.`}</Failed>);
  }
}

void main();
