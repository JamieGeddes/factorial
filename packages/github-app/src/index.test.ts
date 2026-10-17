import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { botGitIdentity, createAppJwt, getApp, mintInstallationToken } from './index.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decode(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('createAppJwt', () => {
  it('produces an RS256 JWT with the expected claims', () => {
    const now = 1_760_000_000;
    const jwt = createAppJwt('12345', privateKeyPem, now);
    const [header, payload, signature] = jwt.split('.');
    assert.ok(header && payload && signature);

    assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(decode(payload), { iat: now - 60, exp: now + 540, iss: '12345' });

    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`).end();
    assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
  });

  it('is rejected by a different public key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const [header, payload, signature] = createAppJwt('1', privateKeyPem).split('.');
    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`).end();
    assert.equal(verifier.verify(other, Buffer.from(signature ?? '', 'base64url')), false);
  });
});

describe('mintInstallationToken', () => {
  const credentials = { appId: '12345', installationId: '67890', privateKeyPem };

  it('posts the JWT to the installation endpoint and returns the token', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ token: 'ghs_abc', expires_at: '2026-10-16T23:00:00Z' }), { status: 201 });
    }) as typeof fetch;

    const result = await mintInstallationToken(credentials, {
      fetchImpl,
      repositories: ['factorial'],
      permissions: { contents: 'read' },
    });

    assert.deepEqual(result, { token: 'ghs_abc', expiresAt: '2026-10-16T23:00:00Z' });
    assert.ok(seen);
    assert.equal(seen.url, 'https://api.github.com/app/installations/67890/access_tokens');
    assert.equal(seen.init.method, 'POST');
    const headers = seen.init.headers as Record<string, string>;
    assert.match(headers.authorization ?? '', /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.deepEqual(JSON.parse(String(seen.init.body)), { repositories: ['factorial'], permissions: { contents: 'read' } });
  });

  it('sends no body when the token is not scoped to repositories', async () => {
    let body: unknown = 'unset';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body;
      return new Response(JSON.stringify({ token: 't', expires_at: 'x' }), { status: 201 });
    }) as typeof fetch;
    await mintInstallationToken(credentials, { fetchImpl });
    assert.equal(body, undefined);
  });

  it('throws with the status and body on failure', async () => {
    const fetchImpl = (async () => new Response('bad credentials', { status: 401 })) as typeof fetch;
    await assert.rejects(mintInstallationToken(credentials, { fetchImpl }), /401 bad credentials/);
  });

  it('throws on a malformed success response', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ nope: true }), { status: 201 })) as typeof fetch;
    await assert.rejects(mintInstallationToken(credentials, { fetchImpl }), /malformed/);
  });
});

describe('getApp', () => {
  it('reads the App record with the JWT and returns its slug', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ id: 42, slug: 'factorial-x', name: 'Factorial (x)' }), { status: 200 });
    }) as typeof fetch;
    const app = await getApp({ appId: '42', privateKeyPem }, { fetchImpl });
    assert.deepEqual(app, { id: 42, slug: 'factorial-x', name: 'Factorial (x)' });
    assert.equal(seen?.url, 'https://api.github.com/app');
    assert.match((seen?.init.headers as Record<string, string>).authorization ?? '', /^Bearer /);
  });

  it('rejects a malformed response', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 'nope' }), { status: 200 })) as typeof fetch;
    await assert.rejects(getApp({ appId: '42', privateKeyPem }, { fetchImpl }), /malformed/);
  });
});

describe('botGitIdentity', () => {
  it("builds the bot user's login and noreply address", () => {
    assert.deepEqual(botGitIdentity('factorial-x', 12345), {
      name: 'factorial-x[bot]',
      email: '12345+factorial-x[bot]@users.noreply.github.com',
    });
  });
});
