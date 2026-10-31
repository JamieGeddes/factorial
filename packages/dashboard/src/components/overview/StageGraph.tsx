'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef } from 'react';

import { useNow } from '../../client/now.tsx';
import { fmtDur, shortId } from '../../lib/format.ts';
import type { Puck } from '../../lib/overview.ts';
import { stageLabel, STAGES, type StageDuration } from '../../lib/stages.ts';

const KIND_LABELS: Record<Puck['kind'], string> = { builder: 'builder session', reviewer: 'reviewer session', rework: 'rework turn', waiting: 'waiting on an external system' };

/** Whether the reader asked for less motion. */
function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The stages in order, each with its p50 over the last 30 runs, and one puck
 * per item in flight on its current stage. A puck that changes stage slides
 * from where it was (unless the reader asked for less motion); a new one fades in.
 */
export function StageGraph({ stages, pucks }: { stages: StageDuration[]; pucks: Puck[] }) {
  const now = useNow();
  const elements = useRef(new Map<string, HTMLElement>());
  const places = useRef(new Map<string, { left: number; top: number; stage: string }>());

  useLayoutEffect(() => {
    const still = reducedMotion();
    const next = new Map<string, { left: number; top: number; stage: string }>();
    for (const puck of pucks) {
      const element = elements.current.get(puck.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      next.set(puck.id, { left: rect.left, top: rect.top, stage: puck.stage });
      const before = places.current.get(puck.id);
      if (still || typeof element.animate !== 'function') continue;
      if (!before) {
        if (places.current.size > 0) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
      } else if (before.stage !== puck.stage) {
        element.animate([{ transform: `translate(${before.left - rect.left}px, ${before.top - rect.top}px)` }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.7,.2,1)' });
      }
    }
    places.current = next;
  }, [pucks]);

  const p50 = new Map(stages.map((s) => [s.stage, s.p50]));
  return (
    <div className="stagemap-track" role="list" aria-label="Stages, with the items in flight on each">
      {STAGES.map((stage) => {
        const here = pucks.filter((p) => p.stage === stage);
        const median = p50.get(stage);
        return (
          <div key={stage} className={`stage${here.length ? ' busy' : ''}`} role="listitem">
            <div className="node" />
            <div className="name">{stageLabel(stage)}</div>
            <div className="meta num">{median !== undefined ? `p50 ${fmtDur(median)}` : 'p50 –'}</div>
            <div className="pucks">
              {here.map((puck) => {
                const since = puck.since ? Date.parse(puck.since) : NaN;
                const name = `${shortId(puck.id)}${puck.ref ? ` ${puck.ref}` : ''}: ${puck.title} (${KIND_LABELS[puck.kind]}${puck.round ? `, round ${puck.round}` : ''})`;
                return (
                  <Link
                    key={puck.id}
                    href={puck.href}
                    className={`puck${puck.kind === 'builder' ? '' : ` ${puck.kind}`}`}
                    title={name}
                    aria-label={`Open the run of ${name}`}
                    ref={(element) => {
                      if (element) elements.current.set(puck.id, element);
                      else elements.current.delete(puck.id);
                    }}
                  >
                    <span className="id">{shortId(puck.id)}</span>
                    {puck.round ? <span className="t">{`r${puck.round}`}</span> : null}
                    <span className="t num">{Number.isFinite(since) && now ? fmtDur((now - since) / 1000) : ''}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
