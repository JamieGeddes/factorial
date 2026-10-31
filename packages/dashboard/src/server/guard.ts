/**
 * The localhost protections (#57), in one module: the part a hosted version
 * replaces with real sign-in. The server acts with the reviewer's own AWS
 * credentials, so a page in their browser that could reach it could read
 * everything:
 *
 * - only `Host: 127.0.0.1:<port>` or `localhost:<port>` is served, so a
 *   rebound DNS name gets 403;
 * - the URL printed at start carries a random token, exchanged on first use
 *   for an `HttpOnly`, `SameSite=Strict` cookie; anything without the cookie
 *   gets 401;
 * - a request that changes anything (the live stream's channel set) must
 *   come from the app's own origin;
 * - every response carries a Content-Security-Policy with a per-request nonce
 *   and `frame-ancestors 'none'`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'factorial_dashboard';

export interface GuardConfig {
  /** The token printed at start; unset means nothing is served. */
  token: string | undefined;
  port: string;
}

export type Decision =
  | { kind: 'deny'; status: 401 | 403; reason: string }
  | { kind: 'exchange'; location: string; cookie: string }
  | { kind: 'allow' };

export interface GuardRequest {
  url: URL;
  method: string;
  host: string | null;
  origin: string | null;
  cookie: string | undefined;
}

/** What the cookie holds: a digest of the token, so the cookie and the URL never carry the same secret. */
export function sessionValue(token: string): string {
  return createHash('sha256').update(`factorial-dashboard:${token}`).digest('hex');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function allowedHosts(port: string): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function decide(request: GuardRequest, config: GuardConfig): Decision {
  const hosts = allowedHosts(config.port);
  if (!request.host || !hosts.includes(request.host.toLowerCase())) return { kind: 'deny', status: 403, reason: 'host not allowed' };
  if (!config.token) return { kind: 'deny', status: 401, reason: 'no token set: start the app with npm run dashboard' };
  const offered = request.url.searchParams.get('token');
  if (offered !== null) {
    if (request.method !== 'GET' || !same(offered, config.token)) return { kind: 'deny', status: 401, reason: 'wrong token' };
    // The host is one of the allowed two, so the redirect stays on the app.
    const location = new URL(request.url.pathname, `http://${request.host.toLowerCase()}`);
    for (const [key, value] of request.url.searchParams) if (key !== 'token') location.searchParams.append(key, value);
    const cookie = `${COOKIE}=${sessionValue(config.token)}; Path=/; HttpOnly; SameSite=Strict`;
    return { kind: 'exchange', location: location.href, cookie };
  }
  if (!request.cookie || !same(request.cookie, sessionValue(config.token))) return { kind: 'deny', status: 401, reason: 'not signed in: open the URL printed at start' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origins = hosts.map((h) => `http://${h}`);
    if (!request.origin || !origins.includes(request.origin.toLowerCase())) return { kind: 'deny', status: 403, reason: 'cross-origin request' };
  }
  return { kind: 'allow' };
}

/**
 * The policy for a page, as the Next.js documentation sets it up. Style
 * attributes are allowed (`style-src-attr`): the charts and meters set widths
 * and colours inline, and nothing untrusted is ever rendered as markup.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src-elem 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
