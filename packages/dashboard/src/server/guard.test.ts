import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentSecurityPolicy, decide, sessionValue, type GuardRequest } from './guard.ts';

const config = { token: 'secret-token', port: '4757' };
const req = (fields: Partial<GuardRequest> & { path?: string } = {}): GuardRequest => ({
  url: new URL(`http://127.0.0.1:4757${fields.path ?? '/api/work-items'}`),
  method: 'GET',
  host: '127.0.0.1:4757',
  origin: null,
  cookie: undefined,
  ...fields,
});

test('another Host gets 403, whatever else the request carries (DNS rebinding)', () => {
  for (const host of ['evil.example:4757', '127.0.0.1:9999', '0.0.0.0:4757', '127.0.0.1', null]) {
    assert.deepEqual(decide(req({ host, cookie: sessionValue('secret-token') }), config).kind, 'deny');
    assert.equal((decide(req({ host }), config) as { status: number }).status, 403);
  }
  assert.equal(decide(req({ host: 'localhost:4757', cookie: sessionValue('secret-token') }), config).kind, 'allow');
});

test('without the cookie, or with a wrong one, every route gets 401', () => {
  for (const path of ['/', '/work-items', '/api/work-items', '/api/live', '/_next/static/x.js']) {
    assert.deepEqual(decide(req({ path }), config), { kind: 'deny', status: 401, reason: 'not signed in: open the URL printed at start' });
    assert.equal((decide(req({ path, cookie: 'secret-token' }), config) as { status: number }).status, 401);
  }
});

test('the token is exchanged once for an HttpOnly, SameSite=Strict cookie, and dropped from the URL', () => {
  const decision = decide(req({ path: '/work-items?token=secret-token&filter=running' }), config);
  assert.equal(decision.kind, 'exchange');
  if (decision.kind !== 'exchange') return;
  assert.equal(decision.location, 'http://127.0.0.1:4757/work-items?filter=running');
  assert.match(decision.cookie, /HttpOnly/);
  assert.match(decision.cookie, /SameSite=Strict/);
  assert.ok(!decision.cookie.includes('secret-token'));
  assert.equal(decide(req({ cookie: sessionValue('secret-token') }), config).kind, 'allow');
});

test('a wrong token gets 401, and with no token set nothing is served', () => {
  assert.equal((decide(req({ path: '/?token=guess' }), config) as { status: number }).status, 401);
  assert.equal((decide(req({ cookie: sessionValue('') }), { token: undefined, port: '4757' }) as { status: number }).status, 401);
});

test('a request that is not a GET must come from the app itself', () => {
  const cookie = sessionValue('secret-token');
  assert.equal((decide(req({ method: 'POST', cookie, origin: 'https://evil.example' }), config) as { status: number }).status, 403);
  assert.equal((decide(req({ method: 'POST', cookie }), config) as { status: number }).status, 403);
  assert.equal(decide(req({ method: 'POST', cookie, origin: 'http://127.0.0.1:4757' }), config).kind, 'allow');
});

test('the CSP uses the nonce and forbids framing', () => {
  const csp = contentSecurityPolicy('abc', false);
  assert.match(csp, /script-src 'self' 'nonce-abc' 'strict-dynamic'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-eval'));
});
