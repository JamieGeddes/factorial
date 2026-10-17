import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cloneScript } from './prepare.ts';

describe('cloneScript', () => {
  const params = {
    owner: 'JamieGeddes',
    name: 'factorial',
    branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    token: 'ghs_tok',
    workItemJson: '{"id":"x"}',
  };

  it('clones with the token as a header, never in the URL, then creates the branch', () => {
    const script = cloneScript(params);
    const basic = Buffer.from('x-access-token:ghs_tok').toString('base64');
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(script, new RegExp(`git -c http\\.extraHeader='AUTHORIZATION: basic ${basic}' clone --quiet 'https://github\\.com/JamieGeddes/factorial\\.git' /workspace/repo`));
    assert.doesNotMatch(script, /ghs_tok/);
    assert.match(script, /git checkout --quiet -b 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
  });

  it('writes the WorkItem via base64 so no JSON reaches the shell unquoted', () => {
    const script = cloneScript(params);
    const encoded = Buffer.from(params.workItemJson).toString('base64');
    assert.match(script, new RegExp(`printf '%s' '${encoded}' \\| base64 -d > /workspace/workitem.json`));
    assert.doesNotMatch(script, /\{"id"/);
  });

  it('rejects owner or repository names that are not plain GitHub names', () => {
    assert.throws(() => cloneScript({ ...params, owner: 'evil;rm -rf /' }), /not a valid GitHub name/);
    assert.throws(() => cloneScript({ ...params, name: "x'y" }), /not a valid GitHub name/);
  });
});
