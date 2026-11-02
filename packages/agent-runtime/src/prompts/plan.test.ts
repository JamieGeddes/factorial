import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PI_TOOLS } from '../pi/tools.ts';
import { planPrompt } from './plan.ts';

describe('the plan prompt', () => {
  const prompt = planPrompt(PI_TOOLS);

  it('offers the explore subagent through the agent tool (#277)', () => {
    assert.match(prompt, /the explore subagent through the task tool/);
  });

  it('sends reading of more than two files to explore, asking for the answer in a set form, and keeps the files a step names for the planner (#277)', () => {
    assert.match(prompt, /When a question means reading more than two files .* ask the explore subagent through task for the answer in the form you want \(for example, file:line with one line on each\) rather than reading them yourself\./);
    assert.match(prompt, /Read yourself the files you will name in steps/);
    assert.match(prompt, /explore's reply is its claim, not evidence/);
  });
});
