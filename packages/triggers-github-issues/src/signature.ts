import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook signature (`X-Hub-Signature-256: sha256=<hex>`)
 * against the raw request body, in constant time.
 */
export function verifyGitHubSignature(
  secret: string,
  body: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const given = signatureHeader.slice('sha256='.length).toLowerCase();
  if (given.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}
