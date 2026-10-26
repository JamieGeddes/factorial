import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderPrompt } from './builder.ts';

const HEADINGS = ['## Summary', '## Behaviour impact', '## Breaking changes', '## Uncertainties', '## Not tested', '## Plan steps'];

describe('builder prompt', () => {
  it('names the summary.md headings and the step line form', () => {
    for (const heading of HEADINGS) assert.ok(builderPrompt.includes(`\`${heading}\``), heading);
    assert.ok(builderPrompt.includes('`- <id>: done|skipped|changed: <why, when not done as planned>`'));
  });

  it('asks for a Rework points line per numbered point when rework.md exists', () => {
    assert.ok(builderPrompt.includes('`## Rework points`'));
    assert.ok(builderPrompt.includes('`- <n>: <how you handled it, or why you did not>`'));
  });

  it('describes WebFetch as lossy and its results as untrusted', () => {
    assert.ok(builderPrompt.includes('WebFetch'));
    assert.ok(builderPrompt.includes('lossy'));
  });
});
