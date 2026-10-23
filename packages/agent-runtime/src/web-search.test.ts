import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_TOOL, search, type GatewayCall } from './web-search.ts';

describe('search', () => {
  it('calls the gateway tool and returns its text', async () => {
    const calls: unknown[] = [];
    const call: GatewayCall = async (body) => {
      calls.push(body);
      return { jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: '{"results":[]}' }] } };
    };
    const output = await search(call, { query: 'node 22 release', maxResults: 5 });
    assert.deepEqual(output, { content: [{ type: 'text', text: '{"results":[]}' }] });
    assert.deepEqual(calls, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: GATEWAY_TOOL, arguments: { query: 'node 22 release', maxResults: 5 } },
      },
    ]);
  });

  it('reports gateway errors and transport failures as tool errors', async () => {
    const rpcError = await search(async () => ({ error: { message: 'throttled' } }), { query: 'x' });
    assert.equal(rpcError.isError, true);
    assert.match(rpcError.content[0]?.text ?? '', /throttled/);

    const thrown = await search(async () => {
      throw new Error('gateway returned HTTP 403');
    }, { query: 'x' });
    assert.equal(thrown.isError, true);
    assert.match(thrown.content[0]?.text ?? '', /403/);

    const empty = await search(async () => ({ result: { content: [] } }), { query: 'x' });
    assert.equal(empty.isError, true);
  });
});
