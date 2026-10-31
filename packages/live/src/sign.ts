/**
 * Requests to the AppSync Events API, signed with SigV4 (service `appsync`)
 * by whoever holds the credentials: the invoker's task role and the
 * forwarder's role to publish, a person's own credentials to subscribe.
 * Publishing is a POST to `https://<http domain>/event`; subscribing signs the
 * same request with the channel as its body and sends the headers over the
 * WebSocket. No API key and no client library: `@smithy/signature-v4` and
 * `@aws-sdk/credential-provider-node` (both Apache-2.0) are what the SDK
 * itself uses.
 */
import { createHash, createHmac } from 'node:crypto';

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

type SourceData = string | ArrayBuffer | ArrayBufferView;

function bytes(data: SourceData): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class Sha256 {
  private readonly hash;
  constructor(secret?: SourceData) {
    this.hash = secret ? createHmac('sha256', bytes(secret)) : createHash('sha256');
  }
  update(data: SourceData): void {
    this.hash.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

/** The headers AppSync expects on a signed WebSocket operation, before signing. */
const WEBSOCKET_HEADERS = {
  accept: 'application/json, text/javascript',
  'content-encoding': 'amz-1.0',
  'content-type': 'application/json; charset=UTF-8',
} as const;

export type Credentials = ReturnType<typeof defaultProvider>;

export interface LiveEndpoint {
  /** The API's HTTP domain (the stack output `LiveHttpDomain`). */
  httpDomain: string;
  region: string;
  credentials?: Credentials;
}

/** The real-time domain that goes with an HTTP domain. */
export function realtimeDomainOf(httpDomain: string): string {
  return httpDomain.replace('.appsync-api.', '.appsync-realtime-api.');
}

function signer(endpoint: LiveEndpoint): SignatureV4 {
  return new SignatureV4({ service: 'appsync', region: endpoint.region, credentials: endpoint.credentials ?? defaultProvider(), sha256: Sha256 });
}

/** Signs a POST to `/event` with `body`, returning the headers to send. */
async function signedHeaders(endpoint: LiveEndpoint, body: string, headers: Record<string, string>): Promise<Record<string, string>> {
  const signed = await signer(endpoint).sign({
    method: 'POST',
    protocol: 'https:',
    hostname: endpoint.httpDomain,
    path: '/event',
    headers: { host: endpoint.httpDomain, ...headers },
    body,
  });
  return signed.headers as Record<string, string>;
}

/** Publishes up to five events to one channel. Resolves with how many the service refused. */
export type PublishBatch = (channel: string, events: string[]) => Promise<{ failed: number }>;

/** Publishing over HTTP with SigV4, each request given at most `timeoutMs`. */
export function httpPublisher(endpoint: LiveEndpoint, timeoutMs = 10_000): PublishBatch {
  return async (channel, events) => {
    const body = JSON.stringify({ channel, events });
    const headers = await signedHeaders(endpoint, body, { 'content-type': 'application/json' });
    const response = await fetch(`https://${endpoint.httpDomain}/event`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`publish returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const result = (await response.json().catch(() => ({}))) as { failed?: unknown };
    return { failed: Array.isArray(result.failed) ? result.failed.length : 0 };
  };
}

/** The headers that authorise a WebSocket connection: sent base64url-encoded as a subprotocol. */
export function connectAuthorization(endpoint: LiveEndpoint): Promise<Record<string, string>> {
  return signedHeaders(endpoint, '{}', { ...WEBSOCKET_HEADERS });
}

/** The headers that authorise one subscribe message. */
export function subscribeAuthorization(endpoint: LiveEndpoint, channel: string): Promise<Record<string, string>> {
  return signedHeaders(endpoint, JSON.stringify({ channel }), { ...WEBSOCKET_HEADERS });
}

/** The subprotocols that open an authorised connection. */
export function connectProtocols(authorization: Record<string, string>): string[] {
  const header = Buffer.from(JSON.stringify(authorization)).toString('base64url');
  return ['aws-appsync-event-ws', `header-${header}`];
}
