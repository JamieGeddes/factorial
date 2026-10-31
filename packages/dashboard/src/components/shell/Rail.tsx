'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useStatus } from '../../client/status.tsx';

const VIEWS = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/', icon: <><rect x="1.5" y="1.5" width="5" height="5" rx="1" /><rect x="9.5" y="1.5" width="5" height="5" rx="1" /><rect x="1.5" y="9.5" width="5" height="5" rx="1" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /></> },
  { href: '/work-items', label: 'Work items', match: (p: string) => p.startsWith('/work-items'), icon: <path d="M2 4h12M2 8h12M2 12h8" />, count: true },
  { href: '/runs', label: 'Run & transcript', match: (p: string) => p.startsWith('/runs'), icon: <><path d="M3 3h10v10H3z" /><path d="M6 6l2 2-2 2M9 10h2" /></> },
  { href: '/metrics', label: 'Metrics & cost', match: (p: string) => p.startsWith('/metrics'), icon: <path d="M2 13l4-5 3 3 5-7" /> },
  { href: '/health', label: 'Health', match: (p: string) => p.startsWith('/health'), icon: <path d="M2 8h3l2-4 2 8 2-4h3" /> },
];

/** The fixed left rail: the five views, the count of running and waiting items, and the versions serving `live`. */
export function Rail() {
  const pathname = usePathname() ?? '/';
  const status = useStatus();
  const active = status?.counts ? status.counts.running + status.counts.waiting : undefined;
  return (
    <aside className="rail">
      <div className="brand">
        <span className="mark" />
        <div>
          <b>Factorial</b>
          <br />
          <small>Command centre</small>
        </div>
      </div>
      <nav aria-label="Views">
        {VIEWS.map((view) => (
          <Link key={view.href} href={view.href} {...(view.match(pathname) ? { 'aria-current': 'page' as const } : {})}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              {view.icon}
            </svg>
            {view.label}
            {view.count && active !== undefined ? (
              <span className="count" aria-label={`${active} running or waiting`}>
                {active}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <div className="rail-foot">
        <span>
          Live version{' '}
          {status?.version ? (
            status.version.url ? (
              <a className="mono" href={status.version.url} target="_blank" rel="noreferrer noopener">
                {status.version.sha.slice(0, 7)}
              </a>
            ) : (
              <b className="mono">{status.version.sha.slice(0, 7)}</b>
            )
          ) : (
            <b>…</b>
          )}
        </span>
        {(status?.runtimes ?? []).map((runtime) => (
          <span key={runtime.name}>
            {runtime.role.charAt(0).toUpperCase() + runtime.role.slice(1)} <b className="mono">{`${runtime.name} ${runtime.version ? `v${runtime.version}` : '(no live version)'}`}</b>
          </span>
        ))}
        <span>
          Region <b>{status?.region ?? 'eu-west-1'}</b>
        </span>
      </div>
    </aside>
  );
}
