import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PI_TOOLS } from '../pi/tools.ts';
import { builderPrompt as prompt } from './builder.ts';

const builderPrompt = prompt(PI_TOOLS);

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

  it("names no repository's paths or commands", () => {
    for (const assumption of ['scripts/classify-changes.ts', 'npm ci', 'npm run', 'npm test', 'npm install', '@scope/']) {
      assert.ok(!builderPrompt.includes(assumption), assumption);
    }
  });

  it('says Collect saves uncommitted work, so a commit records a step whose verification passed (#283)', () => {
    const step = builderPrompt.split('\n').find((line) => line.startsWith('5. '));
    assert.ok(step);
    assert.ok(step.includes('Collect saves whatever you left uncommitted'));
    assert.ok(step.includes('not the only way to keep work'));
    assert.ok(step.includes("whose verification (the plan step's `verification`) has passed, with no file changed since"));
    assert.ok(!step.includes('uncommitted changes may be lost'));
    assert.ok(!step.includes('Commit early and often'));
  });

  it('keeps the && rule and says a pipe hides a check, and a check after a commit does not cover it (#283)', () => {
    const section = builderPrompt.slice(builderPrompt.indexOf('Keeping the session efficient'));
    assert.ok(section.includes('chain with &&, never with ;, so a failing check stops the commit'));
    assert.ok(section.includes("A pipe hides a check's exit code"));
    assert.ok(section.includes('`quiet` already keeps output short, so `| tail` is not needed'));
    assert.ok(section.includes('A check run after a commit'));
    assert.ok(section.includes('does not cover it'));
  });

  it('says packages come from the mirror and no other registry (#242)', () => {
    assert.ok(builderPrompt.includes('internal mirror'));
    assert.ok(builderPrompt.includes('Do not configure another registry'));
  });

  it('says which tool is for what: edit, write, read with offset and limit, grep and find, and bash only for commands (#250)', () => {
    const section = builderPrompt.slice(builderPrompt.indexOf('\nWhich tool for what\n'), builderPrompt.indexOf('\nHow to work\n'));
    assert.ok(section.length > 0);
    assert.match(section, new RegExp(`- ${PI_TOOLS.read} to read a file, with \`offset\` and \`limit\``));
    assert.match(section, new RegExp(`- ${PI_TOOLS.edit} to change an existing file`));
    assert.match(section, new RegExp(`- ${PI_TOOLS.write} to create a file`));
    assert.match(section, new RegExp(`- ${PI_TOOLS.grep} to search file contents and ${PI_TOOLS.glob} to find files by name`));
    assert.match(section, new RegExp(`- ${PI_TOOLS.shell} for commands: git, \`quiet\``));
    assert.match(section, /Never edit a file through bash: no python or node one-off scripts, sed -i, perl -i/);
    assert.match(section, /The host refuses those, and says which tool to use instead\. Printing or searching the repository's files with cat, head, tail, sed -n, grep, rg or find in bash is not refused, but its output comes back with a note/);
    assert.ok(builderPrompt.includes('Write a whole function, test or section in one edit'));
    assert.match(section, new RegExp(`- Calls that do not depend on each other go in one response: several ${PI_TOOLS.read}, ${PI_TOOLS.grep} or ${PI_TOOLS.glob} calls.*count as one turn`));
  });

  it('says bash starts in the repository and names the workspace files by absolute path (#250)', () => {
    assert.ok(builderPrompt.includes(`Every ${PI_TOOLS.shell} command starts in /workspace/repo, so do not begin one with \`cd /workspace/repo\``));
    for (const file of ['/workspace/notes.md', '/workspace/plan.json', '/workspace/plan.md', '/workspace/summary.md']) assert.ok(builderPrompt.includes(file), file);
  });

  it('gives explore concrete triggers and keeps quick steps for the builder (#250)', () => {
    const explore = builderPrompt.split('\n').find((line) => line.startsWith('- The explore subagent'));
    assert.ok(explore);
    assert.ok(explore.includes(`through ${PI_TOOLS.agent}`));
    assert.ok(explore.includes('reading more than two files'));
    for (const trigger of ['every caller or reader of something across packages', 'how a convention is applied', 'which files a pattern touches']) assert.ok(explore.includes(trigger), trigger);
    assert.ok(explore.includes('the question and the form of answer you want'));
    assert.ok(explore.includes('Do it yourself for a quick step'));
  });

  it('describes the fetch tool as lossy and its results as untrusted', () => {
    assert.ok(builderPrompt.includes(PI_TOOLS.fetch));
    assert.ok(builderPrompt.includes('lossy'));
  });
});
