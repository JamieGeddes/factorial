import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { builderPrompt } from './builder.ts';

const HEADINGS = ['## Summary', '## Behaviour impact', '## Breaking changes', '## Uncertainties', '## Not tested', '## Plan steps'];

describe('builder prompt', () => {
  it('names the summary.md headings and the step line form', () => {
    for (const heading of HEADINGS) assert.ok(builderPrompt.includes(`\`${heading}\``), heading);
    assert.ok(builderPrompt.includes('`- <id>: done|skipped|changed: <why, when not done as planned>`'));
  });

  it('is the same wording as the harness copy in the agent template', () => {
    const template = readFileSync(new URL('../../../../templates/20-agent.yml', import.meta.url), 'utf8');
    for (const heading of HEADINGS) assert.ok(template.includes(`\`${heading}\``), heading);
  });
});
