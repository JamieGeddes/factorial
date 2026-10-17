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

  it('clones with the token, then strips it from the remote and creates the branch', () => {
    const script = cloneScript(params);
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /git clone --quiet 'https:\/\/x-access-token:ghs_tok@github\.com\/JamieGeddes\/factorial\.git' \/workspace\/repo/);
    assert.match(script, /git remote set-url origin 'https:\/\/github\.com\/JamieGeddes\/factorial\.git'/);
    assert.match(script, /git checkout --quiet -b 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.ok(script.indexOf('remote set-url') > script.indexOf('git clone'));
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
