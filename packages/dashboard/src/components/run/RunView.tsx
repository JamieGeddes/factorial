'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useNow } from '../../client/now.tsx';
import { useRefreshed } from '../../client/refresh.tsx';
import { useRunEvents } from '../../client/run-events.tsx';
import { fmtDur, fmtK, fmtUsd, shortId } from '../../lib/format.ts';
import type { RunDetail, TimelineRow } from '../../lib/run-view.ts';
import { isPlanWrite, type Tally } from '../../lib/transcript.ts';
import { MeterRow } from '../Meter.tsx';
import { Pill } from '../Pill.tsx';
import { Tag } from '../Tag.tsx';
import { Transcript } from './Transcript.tsx';

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

function Timeline({ rows, now }: { rows: TimelineRow[]; now: number }) {
  const work = (r: TimelineRow) => {
    const start = ms(r.startedAt);
    const end = r.endedAt ? ms(r.endedAt) : now || start;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : 0;
  };
  const max = Math.max(60, ...rows.map((r) => work(r) + (r.waitSeconds ?? 0)));
  return (
    <div className="timeline">
      {rows.map((r) => {
        const w = work(r);
        const wait = r.waitSeconds ?? 0;
        if (r.state === 'todo')
          return (
            <div key={r.key} className="tl-row">
              <span className="n">{r.name}</span>
              <div className="tl-bar" role="img" aria-label={`${r.name}: not reached`}>
                <i className="todo" style={{ width: '100%' }} />
              </div>
              <span className="v" />
            </div>
          );
        return (
          <div key={r.key} className="tl-row">
            <span className="n">{r.name}</span>
            <div className="tl-bar" role="img" aria-label={`${r.name}: work ${fmtDur(w)}, wait ${fmtDur(wait)}${r.state === 'live' ? ', running' : ''}`} title={`work ${fmtDur(w)} · wait ${fmtDur(wait)}`}>
              {wait ? <i className="wait" style={{ width: `${Math.max(1.5, (wait / max) * 100)}%` }} /> : null}
              <i className={`work ${r.state === 'live' ? 'live' : r.state === 'failed' ? 'done-failed' : 'done-ok'}`} style={{ width: `${Math.max(1.5, (w / max) * 100)}%` }} />
            </div>
            <span className="v">{fmtDur(w + wait)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The run's figures: from its events once they have arrived, from the ledger before. */
function figures(detail: RunDetail, tally: Tally, events: number, now: number) {
  const rec = detail.record;
  const live = detail.live;
  const fromEvents = events > 0;
  const usage = (rec?.usage ?? live?.usage ?? {}) as Record<string, number | undefined>;
  const input = fromEvents ? tally.inputTokens : (usage.inputTokens ?? 0);
  const cacheRead = fromEvents ? tally.cacheReadInputTokens : (usage.cacheReadInputTokens ?? 0);
  const startedAt = ms(tally.startedAt ?? detail.startedAt);
  const elapsed =
    tally.ended?.durationMs !== undefined
      ? tally.ended.durationMs / 1000
      : rec?.durationSeconds !== undefined && detail.ended
        ? rec.durationSeconds
        : Number.isFinite(startedAt) && !detail.ended && now
          ? (now - startedAt) / 1000
          : (live?.elapsedSeconds ?? rec?.durationSeconds ?? 0);
  return {
    turns: fromEvents ? tally.turns : (rec?.turns ?? live?.turns ?? 0),
    cost: (fromEvents ? tally.costUsd : undefined) ?? rec?.costUsd ?? live?.costUsd ?? 0,
    elapsed,
    input,
    output: fromEvents ? tally.outputTokens : (usage.outputTokens ?? 0),
    cacheRead,
    uncached: Math.max(0, input - cacheRead),
    modelCalls: fromEvents ? tally.modelCalls : (usage.modelCalls ?? live?.modelCalls ?? 0),
    toolCalls: fromEvents ? tally.toolCalls : (rec?.toolCalls ?? live?.toolCalls ?? 0),
    peak: fromEvents ? tally.peakContext : (usage.maxCallInputTokens ?? 0),
  };
}

function Kv({ items }: { items: [string, string][] }) {
  return (
    <div className="kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function RunView({ initial }: { initial: RunDetail }) {
  const router = useRouter();
  const now = useNow();
  const [paused, setPaused] = useState(false);
  const { data: detail, error, reload } = useRefreshed<RunDetail>(`/api/runs/${initial.id}/${initial.stage}/${initial.round}`, initial, {
    everyMs: initial.ended ? 60_000 : 15_000,
    wants: (m) => m.workItemId === initial.id,
  });
  // The source is the one the page opened with: a run that ends while it is watched keeps its channel, which holds every event.
  const run = useRunEvents(initial.channel, initial.transcript, paused, (entry) => {
    if (isPlanWrite(entry.event)) reload();
  });
  const f = figures(detail, run.tally, run.received, now);
  const limits = detail.limits ?? {};
  const rec = detail.record;
  const harness = run.tally.harness ?? rec?.harness;
  const models = run.tally.models?.length ? run.tally.models.map((m) => `${m.purpose} ${m.id}`) : rec?.modelId ? [rec.modelId] : [];
  const version = [rec?.runtimeName ? `${rec.runtimeName}${rec.runtimeVersion ? ` v${rec.runtimeVersion}` : ''}` : '', harness ? `${harness.name}${harness.version ? ` ${harness.version}` : ''}` : ''].filter(Boolean).join(' · ');
  const items = detail.options.filter((o) => o.group === 'item');
  const others = detail.options.filter((o) => o.group === 'running');
  const current = detail.options.find((o) => o.current)?.href ?? '';

  return (
    <section>
      <div className="run-head">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h1>{`${detail.ref} · ${detail.title}`}</h1>
            <Pill pill={detail.status} />
          </div>
          <div className="ids">
            <Tag>{detail.id}</Tag>
            <Tag>{`attempt ${detail.attempt}`}</Tag>
            <Tag>{`${detail.stage}/${detail.round}`}</Tag>
            {detail.branch ? <Tag>{detail.branch}</Tag> : null}
            {detail.sessionId ? <Tag title="Runtime session id">{`session ${detail.sessionId.length > 40 ? `${shortId(detail.sessionId)}…${detail.sessionId.slice(-3)}` : detail.sessionId}`}</Tag> : null}
            {detail.repository ? <Tag>{detail.repository}</Tag> : null}
            {detail.links.execution ? (
              <a href={detail.links.execution} target="_blank" rel="noreferrer noopener">
                Step Functions execution
              </a>
            ) : null}
            {detail.links.artefacts ? (
              <a href={detail.links.artefacts} target="_blank" rel="noreferrer noopener">
                {`Artefacts ${shortId(detail.id)}/${detail.attempt}/`}
              </a>
            ) : null}
            {detail.links.pullRequest?.url ? (
              <a href={detail.links.pullRequest.url} target="_blank" rel="noreferrer noopener">{`PR #${detail.links.pullRequest.number}`}</a>
            ) : null}
            <a href={detail.links.item}>Work item</a>
          </div>
          {detail.status.note ? <p className="note">{detail.status.note}</p> : null}
          {error ? <div className="error-note" role="alert">{`Could not read the ledger: ${error}`}</div> : null}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="note" htmlFor="run-select" style={{ margin: 0 }}>
            Session
          </label>
          <select id="run-select" className="search" value={current} onChange={(e) => router.push(e.target.value)}>
            <optgroup label="This work item">
              {items.map((o) => (
                <option key={o.href} value={o.href}>
                  {o.label}
                </option>
              ))}
            </optgroup>
            {others.length ? (
              <optgroup label="Other running sessions">
                {others.map((o) => (
                  <option key={o.href} value={o.href}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
      </div>
      <div className="run-layout">
        <div className="run-side">
          <div className="card">
            <div className="card-head">
              <h2>Stages</h2>
              <span className="sub">
                work <i className="key-work" /> wait <i className="key-wait" />
              </span>
            </div>
            <Timeline rows={detail.timeline} now={now} />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Limits</h2>
              <span className="sub">{version}</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <MeterRow name="Turns" value={f.turns} max={limits.maxTurns} display={`${f.turns} / ${limits.maxTurns ?? '–'}`} />
              <MeterRow name="Budget" value={f.cost} max={limits.maxBudgetUsd} display={`${fmtUsd(f.cost)} / ${limits.maxBudgetUsd !== undefined ? fmtUsd(limits.maxBudgetUsd) : '–'}`} />
              <MeterRow name="Time" value={f.elapsed} max={limits.maxDurationSeconds} display={`${fmtDur(f.elapsed)} / ${limits.maxDurationSeconds !== undefined ? fmtDur(limits.maxDurationSeconds) : '–'}`} />
              {detail.limits ? null : <p className="note" style={{ margin: 0 }}>No limits recorded for this run: the live record is another run&apos;s and no usage.json names them.</p>}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Usage this session</h2>
              <span className="sub">{run.received > 0 ? 'from the events' : 'from the ledger'}</span>
            </div>
            <Kv
              items={[
                ['Input tokens', fmtK(f.input)],
                ['Output tokens', fmtK(f.output)],
                ['Cache reads', `${fmtK(f.cacheRead)} (${f.input ? Math.round((f.cacheRead / f.input) * 100) : 0}%)`],
                ['Uncached input', fmtK(f.uncached)],
                ['Model calls', String(f.modelCalls)],
                ['Tool calls', String(f.toolCalls)],
                ['Cost estimate', fmtUsd(f.cost)],
                ['Peak context', fmtK(f.peak)],
              ]}
            />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Session</h2>
              <span className="sub">{detail.role}</span>
            </div>
            <Kv
              items={[
                ['Runtime', rec?.runtimeName ?? '–'],
                ['Version', rec?.runtimeVersion ? `v${rec.runtimeVersion}` : '–'],
                ['Harness', harness ? `${harness.name}${harness.version ? ` ${harness.version}` : ''}` : '–'],
                ['Outcome', run.tally.ended ? `${run.tally.ended.outcome} (${run.tally.ended.reason})` : rec?.outcome ? `${rec.outcome}${rec.stopReason ? ` (${rec.stopReason})` : ''}` : detail.ended ? 'ended' : 'running'],
              ]}
            />
            {models.length ? (
              <ul className="models">
                {models.map((m) => (
                  <li key={m} className="mono">
                    {m}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Plan</h2>
              <span className="sub">{detail.plan ? `${detail.plan.steps.length} steps` : ''}</span>
            </div>
            {detail.plan ? (
              <>
                <div className="plan">
                  {detail.plan.steps.map((step) => (
                    <div key={step.id} className="plan-step">
                      <span className="st" />
                      <div>
                        <div>{step.id}</div>
                        <div className="f">{step.files.join(', ') || 'no files'}</div>
                      </div>
                      <span />
                    </div>
                  ))}
                </div>
                <p className="note">{`From ${detail.plan.source}. Nothing records which step the builder is on.`}</p>
              </>
            ) : (
              <p className="note" style={{ margin: 0 }}>{detail.stage === 'build' ? 'No plan yet: the builder writes plan.json after its plan subagent.' : 'No stored plan for this attempt.'}</p>
            )}
          </div>
        </div>
        <Transcript run={run} channel={detail.channel} paused={paused} onPause={setPaused} />
      </div>
    </section>
  );
}
