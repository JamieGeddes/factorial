import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectAuthorization, connectProtocols, realtimeDomainOf, subscribeAuthorization } from './sign.ts';

const endpoint = {
  httpDomain: 'example1234567890000.appsync-api.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' }),
};

test('the real-time domain is the HTTP domain on the real-time endpoint', () => {
  assert.equal(realtimeDomainOf(endpoint.httpDomain), 'example1234567890000.appsync-realtime-api.eu-west-1.amazonaws.com');
});

test('a connection and a subscription are signed for appsync with the headers AppSync names', async () => {
  for (const headers of [await connectAuthorization(endpoint), await subscribeAuthorization(endpoint, '/factorial/work-items')]) {
    assert.equal(headers.host, endpoint.httpDomain);
    assert.equal(headers['content-encoding'], 'amz-1.0');
    assert.equal(headers['x-amz-security-token'], 'token');
    assert.match(headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/appsync\/aws4_request, SignedHeaders=accept;content-encoding;content-type;host;/);
  }
  assert.notEqual((await connectAuthorization(endpoint)).authorization, (await subscribeAuthorization(endpoint, '/factorial/work-items')).authorization);
});

test('the connection subprotocols carry the headers base64url-encoded', () => {
  const [protocol, header] = connectProtocols({ host: 'h', authorization: 'a+b/c' });
  assert.equal(protocol, 'aws-appsync-event-ws');
  assert.deepEqual(JSON.parse(Buffer.from((header ?? '').replace(/^header-/, ''), 'base64url').toString()), { host: 'h', authorization: 'a+b/c' });
  assert.doesNotMatch(header ?? '', /[+/=]/);
});
