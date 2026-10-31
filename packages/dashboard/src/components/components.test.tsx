import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { summarise } from '../lib/work-items.ts';
import { Meter } from './Meter.tsx';
import { Pill } from './Pill.tsx';
import { WorkItemsTable } from './work-items/WorkItemsTable.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

const ID = '7f93ccb0-d53d-11f1-8851-ff488f20a8b2';
const hostile = summarise(
  {
    workItemId: ID,
    createdAt: '2026-11-01T10:00:00Z',
    result: 'refused',
    status: 'busy',
    refusedReason: '<script>alert(2)</script>',
    branch: '<b>branch</b>',
    workItem: { title: '<img src=x onerror=alert(1)>', requestedBy: '<i>me</i>', source: { type: 'github-issue', id: '1' }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  },
  undefined,
  Date.parse('2026-11-01T10:10:00Z'),
);

test('a work item titled <img src=x onerror=alert(1)> shows as text', () => {
  const html = render(<WorkItemsTable items={[hostile]} empty="none" />);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(!html.includes('<b>branch'));
  assert.ok(!html.includes('<i>me'));
});

test('a row links to the item, and an empty table says what to clear', () => {
  assert.match(render(<WorkItemsTable items={[hostile]} empty="none" />), new RegExp(`href="/work-items/${ID}"`));
  assert.match(render(<WorkItemsTable items={[]} empty="Clear the Running filter to see more." />), /Clear the Running filter to see more\./);
});

test('meters warn above 65% and are critical above 85%', () => {
  assert.match(render(<Meter value={65} max={100} label="m" />), /class="meter"/);
  assert.match(render(<Meter value={66} max={100} label="m" />), /class="meter warn"/);
  assert.match(render(<Meter value={86} max={100} label="m" />), /class="meter crit"/);
  assert.match(render(<Meter value={150} max={100} label="m" />), /width:100%/);
});

test('a pill shows its tone and, when asked, its note', () => {
  assert.equal(render(<Pill pill={{ label: 'testing', tone: 'waiting' }} />), '<span class="pill waiting">testing</span>');
  assert.match(render(<Pill pill={{ label: 'incomplete', tone: 'failed', note: 'Saved to factorial/x' }} withNote />), /<span class="sub">Saved to factorial\/x<\/span>/);
});

/** Every module a browser bundle can reach: client components and what they import, never the server's. */
test('no client module imports @factorial/live beyond its channel names, or anything under server/', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));
  const client = files.filter((f) => readFileSync(path.join(src, f), 'utf8').startsWith("'use client'"));
  assert.ok(client.length > 5);
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(path.join(src, file), 'utf8');
    for (const [, spec] of text.matchAll(/from '([^']+)'/g)) {
      if (!spec) continue;
      if (spec.startsWith('@factorial/')) assert.equal(spec, '@factorial/live/channels', `${file} imports ${spec}`);
      if (spec.startsWith('.')) {
        const target = path.relative(src, path.resolve(path.dirname(path.join(src, file)), spec));
        assert.ok(!target.startsWith('server'), `${file} imports ${spec}`);
        visit(target);
      }
    }
  };
  for (const file of client) visit(file);
});
