import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPLORE, PLAN } from './agents.ts';
import { HOST_ROLES } from './roles.ts';

describe('the gateway tools each role is offered', () => {
  it('gives the builder web search and the AWS documentation', () => {
    assert.deepEqual(HOST_ROLES.builder.gatewayTools, ['webSearch', 'awsDocs']);
  });

  it('gives the reviewer none: everything it judges is in the session', () => {
    assert.deepEqual(HOST_ROLES.reviewer.gatewayTools, []);
  });

  it('gives the plan subagent the builder\'s and the explore subagent none', () => {
    for (const set of HOST_ROLES.builder.gatewayTools) assert.ok(PLAN.tools.includes(set), set);
    assert.ok(!EXPLORE.tools.includes('webSearch'));
    assert.ok(!EXPLORE.tools.includes('awsDocs'));
  });
});

describe('the subagents each subagent may start (#277)', () => {
  it('lets the plan subagent start explore and nothing else, through its agent tool', () => {
    assert.deepEqual(Object.keys(PLAN.subagents ?? {}), ['explore']);
    assert.equal(PLAN.subagents?.explore, EXPLORE);
    assert.ok(PLAN.tools.includes('agent'));
  });

  it('lets explore start none', () => {
    assert.equal(EXPLORE.subagents, undefined);
    assert.ok(!EXPLORE.tools.includes('agent'));
  });
});
