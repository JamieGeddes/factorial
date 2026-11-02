/**
 * `npm run snapshot:capture`: reads everything the command centre shows, with
 * the caller's AWS credentials, and writes it under `snapshot-out/data/` for
 * `build.ts` to serve as a static page. Every data route's answer is kept as
 * the live app would have sent it at this moment; the clock the views read
 * is this moment too, so a running item stays running and "today" stays today.
 *
 * The AWS account id is replaced before anything is written: a snapshot is
 * for sharing, and the id is kept out of everything shared (CLAUDE.md).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStageKey } from '../src/lib/stage-key.ts';
import { RANGES } from '../src/lib/metrics.ts';
import { readAll } from '../src/lib/read-all.ts';
import { transcriptPath } from '../src/lib/run-view.ts';
import { RUN_FOLDERS } from '../src/lib/stages.ts';
import { compareItems, summarise } from '../src/lib/work-items.ts';
import { itemKey } from '../src/server/artefacts.ts';
import { healthPage, metricsPage, overviewPage, runPage, runsPage, safeContentType, statusBar, workItemDetail, workItemsPage } from '../src/server/handlers.ts';
import { services } from '../src/server/services.ts';
import { metricsKey, runKey, SNAPSHOT_FORMAT, type ArtefactEntry, type SnapshotIndex, type SnapshotItem } from './format.ts';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'snapshot-out');
const dataDir = path.join(out, 'data');

const CHUNK = /^(\d+)\/(build(?:\/round-\d+)?|review)\/live\/(\d{4})\.jsonl$/;
const TRANSCRIPT = /^(\d+)\/(build|review)(?:\/round-(\d+))?\/transcript\.jsonl$/;
const BINARY = /\.(git|bundle|zip|gz|tar|png|jpg)$/i;

async function main(): Promise<void> {
  const s = services();
  const capturedAtMs = Date.now();
  s.now = () => capturedAtMs;
  const config = await s.config();
  const account = /(\d{12})$/.exec(config.bucket)?.[1];
  const redact = (value: string): string => (account ? value.split(account).join('000000000000') : value);
  // Every file lands under `snapshot-out/`, whatever an object key holds.
  const write = async (file: string, body: string) => {
    const full = path.resolve(out, file);
    if (!full.startsWith(out + path.sep)) throw new Error(`"${file}" would leave ${out}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, redact(body));
  };
  const writeJson = (file: string, value: unknown) => write(file, JSON.stringify(value));

  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  console.log(`Capturing the command centre at ${new Date(capturedAtMs).toISOString()} into ${out}`);

  const rows = await s.ledger.list();
  const threads = await s.threads.all();
  const items: SnapshotIndex['items'] = {};
  let files = 0;
  let bytes = 0;
  let runCount = 0;
  for (const row of [...rows].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))) {
    const id = row.workItemId;
    const detail = await workItemDetail(s, id);
    if (!detail) continue;
    const attempt = typeof row.attempt === 'number' ? row.attempt : 1;

    // Every run the row records, and the live one.
    const wanted = new Map<string, { stage: string; round: number }>();
    for (const key of Object.keys(row.stages ?? {})) {
      const { stage, round } = parseStageKey(key);
      const folder = RUN_FOLDERS[stage];
      if (folder) wanted.set(runKey(folder, round ?? 1), { stage: folder, round: round ?? 1 });
    }
    if (row.live?.stage && /^[a-z]+$/.test(row.live.stage)) wanted.set(runKey(row.live.stage, row.live.round ?? 1), { stage: row.live.stage, round: row.live.round ?? 1 });
    // A row from before the progress record (#15) names no runs, but its transcripts are there, and the run route serves them.
    for (const object of detail.artefacts) {
      const found = TRANSCRIPT.exec(object.key.slice(id.length + 1));
      if (found && Number(found[1]) === attempt) wanted.set(runKey(found[2] as string, Number(found[3] ?? 1)), { stage: found[2] as string, round: Number(found[3] ?? 1) });
    }
    const runs: SnapshotItem['runs'] = {};
    for (const [key, { stage, round }] of wanted) {
      const run = await runPage(s, id, stage, round);
      if (run) runs[key] = run;
    }

    // Every object under the item: transcripts as files, binaries left out, the rest inline.
    const artefacts: SnapshotItem['artefacts'] = {};
    const chunks = new Map<string, string[]>();
    for (const object of detail.artefacts) {
      const rel = object.key.slice(id.length + 1);
      // A key the routes would refuse (`..`, an empty segment, a backslash) is left out, as the app leaves it out.
      if (itemKey(id, rel) !== object.key) continue;
      const contentType = safeContentType(object.key, 'text/plain');
      let entry: ArtefactEntry;
      if (BINARY.test(rel)) entry = { kind: 'binary', size: object.size };
      else {
        const text = await s.artefacts.once(object.key);
        if (text === undefined) continue;
        if (rel.endsWith('/transcript.jsonl')) {
          const file = `data/files/${id}/${rel}`;
          await write(file, text);
          files += 1;
          bytes += object.size;
          entry = { kind: 'file', file, size: object.size, contentType };
        } else entry = { kind: 'text', text, contentType };
        const chunk = CHUNK.exec(rel);
        if (chunk) chunks.set(`${chunk[1]}/${chunk[2]}`, [...(chunks.get(`${chunk[1]}/${chunk[2]}`) ?? []), text]);
      }
      artefacts[rel] = entry;
    }

    // A run still going has no transcript yet: its catch-up chunks, in order, stand in for one.
    for (const run of Object.values(runs)) {
      if (run.transcript) continue;
      const stored = transcriptPath(row, run.stage, run.round);
      const folder = stored.replace(/\/transcript\.jsonl$/, '');
      const lines = chunks.get(folder);
      if (!lines?.length) continue;
      const rel = `${folder}/live-transcript.jsonl`;
      const text = lines.map((t) => t.replace(/\n$/, '')).join('\n') + '\n';
      const file = `data/files/${id}/${rel}`;
      await write(file, text);
      files += 1;
      bytes += text.length;
      artefacts[rel] = { kind: 'file', file, size: text.length, contentType: 'application/x-ndjson; charset=utf-8' };
      run.transcript = `/api/work-items/${id}/artefacts/${rel.split('/').map(encodeURIComponent).join('/')}`;
    }

    const file = `data/items/${id}.json`;
    await writeJson(file, { detail, runs, artefacts } satisfies SnapshotItem);
    items[id] = { file };
    runCount += Object.keys(runs).length;
    console.log(`  ${id}  attempt ${attempt}  ${Object.keys(runs).length} runs  ${detail.artefacts.length} artefacts  ${detail.summary.status.label}`);
  }

  console.log('Reading the views…');
  const [status, overview, health, workItems, runs, running] = await Promise.all([
    statusBar(s),
    overviewPage(s),
    healthPage(s),
    readAll((cursor) => workItemsPage(s, { filter: 'all', limit: '500', ...(cursor ? { cursor } : {}) })),
    runsPage(s),
    s.ledger.running(),
  ]);
  const metrics: SnapshotIndex['metrics'] = {};
  const widest = await metricsPage(s, { range: '90' });
  for (const range of RANGES) {
    for (const repository of ['', ...widest.repositories]) metrics[metricsKey(range, repository)] = await metricsPage(s, { range: String(range), repository });
  }
  const index: SnapshotIndex = {
    format: SNAPSHOT_FORMAT,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    redacted: account ? ['the AWS account id'] : [],
    status,
    overview,
    running: { items: running.map((row) => ({ summary: summarise(row, row.threadKey ? threads.get(row.threadKey) : undefined, capturedAtMs), live: row.live ?? null })).sort((a, b) => compareItems(a.summary, b.summary)) },
    health,
    metrics,
    workItems,
    runs,
    runCount,
    items,
  };
  await writeJson('data/snapshot.json', index);
  console.log(`Done: ${rows.length} work items, ${Object.keys(metrics).length} metrics views, ${files} transcript files (${(bytes / 1048576).toFixed(1)} MiB). Now \`npm run snapshot:build\`.`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
