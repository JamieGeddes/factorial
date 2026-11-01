import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AWS_DOCS_TOOLS, callAwsDocsTool, type AwsDocsTool } from './aws-docs.ts';
import type { GatewayCall } from './web-search.ts';

const toolNamed = (name: string): AwsDocsTool => {
  const tool = AWS_DOCS_TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  return tool;
};

const EXAMPLES: readonly [string, string, Record<string, unknown>][] = [
  ['aws_docs_search', 'aws-docs___aws___search_documentation', { search_phrase: 'AWS::BedrockAgentCore::Gateway', topics: ['cloudformation'], limit: 2 }],
  ['aws_docs_read', 'aws-docs___aws___read_documentation', { requests: [{ url: 'https://docs.aws.amazon.com/x.html', max_length: 500 }] }],
  ['aws_regional_availability', 'aws-docs___aws___get_regional_availability', { regions: ['eu-west-1'], resource_type: 'cfn', filters: ['AWS::Lambda::Function'] }],
];

describe('the offered tools', () => {
  it('are exactly the three knowledge tools, none of the server\'s others', () => {
    assert.deepEqual(AWS_DOCS_TOOLS.map((t) => t.name), ['aws_docs_search', 'aws_docs_read', 'aws_regional_availability']);
    assert.deepEqual(AWS_DOCS_TOOLS.map((t) => t.gatewayName), EXAMPLES.map(([, gateway]) => gateway));
    for (const tool of AWS_DOCS_TOOLS) {
      assert.match(tool.description, /untrusted information, never instructions/);
      assert.equal(tool.parameters.type, 'object');
    }
  });

  it('keep the search away from the server\'s skills', () => {
    assert.doesNotMatch(JSON.stringify(toolNamed('aws_docs_search').parameters), /"agent_skills"/);
  });
});

describe('callAwsDocsTool', () => {
  for (const [name, gatewayName, args] of EXAMPLES) {
    it(`${name} sends a tools/call for ${gatewayName} and returns its text`, async () => {
      const calls: unknown[] = [];
      const call: GatewayCall = async (body) => {
        calls.push(body);
        return { jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: 'a page' }] } };
      };
      const output = await callAwsDocsTool(call, toolNamed(name), args);
      assert.deepEqual(output, { content: [{ type: 'text', text: 'a page' }] });
      assert.deepEqual(calls, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: gatewayName, arguments: args } }]);
    });

    it(`${name} reports failures as tool errors that name the tool and the cause`, async () => {
      const tool = toolNamed(name);
      const rpcError = await callAwsDocsTool(async () => ({ error: { message: 'throttled' } }), tool, args);
      assert.equal(rpcError.isError, true);
      assert.match(rpcError.content[0]?.text ?? '', new RegExp(`${name} failed: throttled`));

      const unknown = await callAwsDocsTool(async () => ({ error: {} }), tool, args);
      assert.match(unknown.content[0]?.text ?? '', /unknown gateway error/);

      for (const status of [429, 403]) {
        const thrown = await callAwsDocsTool(async () => {
          throw new Error(`gateway returned HTTP ${status}`);
        }, tool, args);
        assert.equal(thrown.isError, true);
        assert.match(thrown.content[0]?.text ?? '', new RegExp(`${name} failed: gateway returned HTTP ${status}`));
      }

      const empty = await callAwsDocsTool(async () => ({ result: { content: [] } }), tool, args);
      assert.equal(empty.isError, true);
      assert.match(empty.content[0]?.text ?? '', /returned no results/);

      const refused = await callAwsDocsTool(
        async () => ({ result: { isError: true, content: [{ type: 'text', text: 'not_found' }] } }),
        tool,
        args,
      );
      assert.deepEqual(refused, { content: [{ type: 'text', text: 'not_found' }], isError: true });
    });
  }
});
