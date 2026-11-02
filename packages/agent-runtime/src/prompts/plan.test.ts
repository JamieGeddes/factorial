import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PI_TOOLS } from '../pi/tools.ts';
import { planPrompt } from './plan.ts';

describe('the plan prompt', () => {
  const prompt = planPrompt(PI_TOOLS);

  it('offers the explore subagent through the agent tool (#277)', () => {
    assert.match(prompt, /the explore subagent through the task tool/);
  });

  it('makes explore its own step, before the planner reads the code, and names the questions that call for it (#277)', () => {
    const explore = prompt.indexOf('2. Send each question whose answer is spread over more than two files to the explore subagent through task');
    const reading = prompt.indexOf('3. Then read the code the request touches yourself');
    assert.ok(explore > 0 && reading > explore, 'explore comes before the planner reads the code');
    assert.match(prompt, /and do not open those files yourself to answer it\./);
    for (const question of ['whether one package or module may use another', 'how a file or setting reaches a bundle, image or deployment', 'every caller or reader of something', 'how a convention is applied across the repository', 'which files a pattern touches']) {
      assert.ok(prompt.includes(question), question);
    }
    assert.match(prompt, /the form of answer you want \(for example, file:line with one line on each\)/);
    assert.match(prompt, /independent questions go to several explore calls in one response/);
  });

  it("keeps the files a step names for the planner to read, and treats explore's reply as a claim (#277)", () => {
    assert.match(prompt, /the files you will name in steps and anything a step's change depends on/);
    assert.match(prompt, /Explore's reply is its claim, not evidence/);
  });

  it('numbers its steps 1 to 7 in order', () => {
    const steps = [...prompt.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]));
    assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7]);
  });
});
