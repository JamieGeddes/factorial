'use client';

import { useState, type FormEvent } from 'react';

import { useLive } from '../../client/live.tsx';
import { SCORE_KEYS, VERDICTS, verdictTone, type ScoreKey, type Verdict } from '../../lib/human-scores.ts';
import type { OwnScore, ScorePanel as ScorePanelData } from '../../lib/run-view.ts';

/** The longest comment the contract takes (`HUMAN_COMMENT_MAX` in `@factorial/review`, which a browser bundle cannot take). */
const COMMENT_MAX = 8000;
const LABELS: Record<ScoreKey, string> = { correctness: 'Correctness', completeness: 'Completeness', tests: 'Tests', safety: 'Safety' };
const VERDICT_LABELS: Record<Verdict, string> = { approve: 'Approve', 'request-changes': 'Request changes', comment: 'Comment' };

const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
};

interface Column {
  key: string;
  name: string;
  verdict: string;
  scores: Record<string, number>;
  mean?: number;
  at?: string;
}

/** The agent's scores beside each person's, field for field. */
function Compare({ columns }: { columns: Column[] }) {
  return (
    <table className="score-compare">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Field</span>
          </th>
          {columns.map((c) => (
            <th key={c.key} scope="col" title={c.at ? `Recorded ${time(c.at)}` : undefined}>
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Verdict</th>
          {columns.map((c) => (
            <td key={c.key}>
              <span className={`pill ${verdictTone(c.verdict)}`}>{c.verdict}</span>
            </td>
          ))}
        </tr>
        {SCORE_KEYS.map((k) => (
          <tr key={k}>
            <th scope="row">{LABELS[k]}</th>
            {columns.map((c) => (
              <td key={c.key} className="num">
                {typeof c.scores[k] === 'number' ? c.scores[k] : '–'}
              </td>
            ))}
          </tr>
        ))}
        <tr className="mean">
          <th scope="row">Mean</th>
          {columns.map((c) => (
            <td key={c.key} className="num">
              {c.mean !== undefined ? c.mean.toFixed(2) : '–'}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

type Sent = { state: 'idle' } | { state: 'sending' } | { state: 'sent'; at: string } | { state: 'failed'; error: string };

/** The form, prefilled with the reviewer's last score on the attempt. Keyed by that score, so a new one starts it afresh. */
function ScoreForm({ id, reviewer, own, readOnly, onRecorded }: { id: string; reviewer: string; own?: OwnScore; readOnly: boolean; onRecorded: () => void }) {
  const [verdict, setVerdict] = useState<Verdict | undefined>(own?.verdict);
  const [scores, setScores] = useState<Partial<Record<ScoreKey, number>>>(own?.scores ?? {});
  const [comment, setComment] = useState(own?.comment ?? '');
  const [sent, setSent] = useState<Sent>({ state: 'idle' });
  const complete = verdict !== undefined && SCORE_KEYS.every((k) => scores[k] !== undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || readOnly) return;
    setSent({ state: 'sending' });
    try {
      const response = await fetch(`/api/work-items/${id}/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict, scores, comment }),
      });
      const body = (await response.json()) as { score?: { at: string }; error?: string };
      if (!response.ok || !body.score) throw new Error(body.error ?? `HTTP ${response.status}`);
      setSent({ state: 'sent', at: body.score.at });
      onRecorded();
    } catch (e) {
      setSent({ state: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <form className="score-form" onSubmit={submit} aria-label="Your score">
      <fieldset disabled={readOnly || sent.state === 'sending'}>
        <legend>
          {`Your score, as ${reviewer}`}
          {own ? <span className="sub">{` · last recorded ${time(own.at)}`}</span> : null}
        </legend>
        <div className="score-row" role="radiogroup" aria-label="Verdict">
          <span className="k">Verdict</span>
          <span className="picks">
            {VERDICTS.map((v) => (
              <label key={v} className="chip">
                <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} />
                {VERDICT_LABELS[v]}
              </label>
            ))}
          </span>
        </div>
        {SCORE_KEYS.map((k) => (
          <div key={k} className="score-row" role="radiogroup" aria-label={`${LABELS[k]}, 1 (poor) to 5 (excellent)`}>
            <span className="k">{LABELS[k]}</span>
            <span className="picks">
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="chip num">
                  <input type="radio" name={k} value={n} checked={scores[k] === n} onChange={() => setScores((s) => ({ ...s, [k]: n }))} />
                  {n}
                </label>
              ))}
            </span>
          </div>
        ))}
        <label className="score-comment">
          <span className="k">Comment</span>
          <textarea className="search" value={comment} maxLength={COMMENT_MAX} rows={4} onChange={(e) => setComment(e.target.value)} placeholder="What the agent's review missed, or got right" />
          <span className="sub num">{`${comment.length.toLocaleString()} / ${COMMENT_MAX.toLocaleString()}`}</span>
        </label>
        <div className="score-submit">
          <button type="submit" className="btn" disabled={!complete}>
            {own ? 'Record again' : 'Record score'}
          </button>
          <span className="note" role="status" aria-live="polite">
            {readOnly
              ? 'A snapshot records nothing.'
              : sent.state === 'sending'
                ? 'Recording…'
                : sent.state === 'sent'
                  ? `Recorded ${time(sent.at)}`
                  : sent.state === 'failed'
                    ? ''
                    : complete
                      ? ''
                      : 'Choose a verdict and all four scores.'}
          </span>
        </div>
        {sent.state === 'failed' ? (
          <div className="error-note" role="alert">
            {`Not recorded: ${sent.error}`}
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}

/** The Run & transcript view's score panel (#227): the reviewer agent's scores, the people's, and the form, which records nothing in a snapshot. */
export function ScorePanel({ id, panel, onRecorded }: { id: string; panel: ScorePanelData; onRecorded: () => void }) {
  return <ScorePanelView id={id} panel={panel} onRecorded={onRecorded} readOnly={useLive().state === 'snapshot'} />;
}

export function ScorePanelView({ id, panel, onRecorded, readOnly }: { id: string; panel: ScorePanelData; onRecorded: () => void; readOnly: boolean }) {
  const columns: Column[] = [
    ...(panel.agent ? [{ key: 'agent', name: 'Agent', verdict: panel.agent.verdict, scores: panel.agent.scores, ...(panel.agent.mean !== undefined ? { mean: panel.agent.mean } : {}) }] : []),
    ...panel.humans.map((h) => ({ key: `human-${h.reviewer}`, name: h.reviewer === panel.reviewer ? 'You' : h.reviewer, verdict: h.verdict, scores: h.scores, mean: h.mean, at: h.at })),
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Scores</h2>
        <span className="sub">{`attempt ${panel.attempt}`}</span>
      </div>
      {columns.length ? <Compare columns={columns} /> : <p className="note" style={{ margin: 0 }}>No review yet, by the agent or anyone.</p>}
      {panel.reviewer ? (
        <ScoreForm key={`${panel.attempt} ${panel.own?.at ?? 'new'}`} id={id} reviewer={panel.reviewer} {...(panel.own ? { own: panel.own } : {})} readOnly={readOnly} onRecorded={onRecorded} />
      ) : (
        <p className="note">Scoring needs the app&apos;s AWS identity, which could not be read.</p>
      )}
    </div>
  );
}
