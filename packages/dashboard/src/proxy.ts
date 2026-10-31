import { NextResponse, type NextRequest } from 'next/server';

import { COOKIE, contentSecurityPolicy, decide } from './server/guard.ts';

/** Every request passes the localhost guard (`server/guard.ts`) first. */
export function proxy(request: NextRequest): NextResponse {
  const decision = decide(
    {
      url: request.nextUrl,
      method: request.method,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      cookie: request.cookies.get(COOKIE)?.value,
    },
    { token: process.env.DASHBOARD_TOKEN, port: process.env.DASHBOARD_PORT ?? '4757' },
  );
  if (decision.kind === 'deny') {
    return new NextResponse(`${decision.status === 401 ? 'Unauthorised' : 'Forbidden'}: ${decision.reason}\n`, {
      status: decision.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (decision.kind === 'exchange') {
    return new NextResponse(null, { status: 303, headers: { location: decision.location, 'set-cookie': decision.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-frame-options', 'DENY');
  return response;
}

export const config = {
  matcher: '/:path*',
};
