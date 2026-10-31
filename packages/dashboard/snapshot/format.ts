import type { WorkItemDetailData } from '../src/components/work-items/WorkItemDetail.tsx';
import type { Health } from '../src/lib/health.ts';
import type { Metrics } from '../src/lib/metrics.ts';
import type { Overview } from '../src/lib/overview.ts';
import type { LiveProgress } from '../src/lib/records.ts';
import type { RunDetail } from '../src/lib/run-view.ts';
import type { WorkItemSummary } from '../src/lib/work-items.ts';
import type { StatusBar, WorkItemsPage } from '../src/server/handlers.ts';

/**
 * A snapshot of the command centre: every data route's response at one
 * moment, so the same views can be served as static files with nothing live
 * behind them (`docs/dashboard.md`, "A snapshot to share").
 *
 * `data/snapshot.json` is the index; each work item's detail, runs and
 * artefacts are in `data/items/<id>.json`, read when a view asks for them;
 * transcripts are their own files under `data/files/`, read as a stream like
 * the live app reads them.
 */
export const SNAPSHOT_FORMAT = 1;

export interface SnapshotIndex {
  format: typeof SNAPSHOT_FORMAT;
  /** When the snapshot was taken: the page's clock stands here. */
  capturedAt: string;
  capturedAtMs: number;
  /** What was replaced before writing, for the banner. */
  redacted: string[];
  status: StatusBar;
  overview: Overview;
  running: { items: { summary: WorkItemSummary; live: LiveProgress | null }[] };
  health: Health;
  /** By `${range}|${repository}`, every range for every repository and for all. */
  metrics: Record<string, Metrics>;
  /** Every item, unfiltered; the page filters in the browser with the same functions the server uses. */
  workItems: WorkItemsPage;
  /** The `/runs` list. */
  runs: WorkItemSummary[];
  /** How many agent runs the items hold, for the banner. */
  runCount: number;
  /** Each item's file, relative to `index.html`. */
  items: Record<string, { file: string }>;
}

export type ArtefactEntry =
  | { kind: 'text'; text: string; contentType: string }
  | { kind: 'file'; file: string; size: number; contentType: string }
  | { kind: 'binary'; size: number };

export interface SnapshotItem {
  detail: WorkItemDetailData;
  /** By `${stage}/${round}`, as the run route names them. */
  runs: Record<string, RunDetail>;
  /** By path under `<id>/`. */
  artefacts: Record<string, ArtefactEntry>;
}

export const metricsKey = (range: string | number, repository: string): string => `${range}|${repository}`;
export const runKey = (stage: string, round: number | string): string => `${stage}/${round}`;
