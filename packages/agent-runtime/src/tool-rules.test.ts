import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideReviewerToolUse, decideToolUse, writesByRedirection } from './tool-rules.ts';
import type { ToolCall } from './tools.ts';

const write = (path?: string): ToolCall => ({ kind: 'write', path });
const edit = (path?: string): ToolCall => ({ kind: 'edit', path });
const notebook = (path?: string): ToolCall => ({ kind: 'notebook', path });
const shell = (command: string): ToolCall => ({ kind: 'shell', command });
const other = (name: string): ToolCall => ({ kind: 'other', name });

const allowed = (call: ToolCall) => decideToolUse('/workspace', call).allow;

describe('decideToolUse', () => {
  it('allows file writes inside the workspace', () => {
    assert.equal(allowed(write('/workspace/repo/src/a.ts')), true);
    assert.equal(allowed(edit('/workspace/notes.md')), true);
    assert.equal(allowed(write('repo/relative.ts')), true);
  });

  it('denies file writes outside the workspace or into host-owned directories', () => {
    assert.equal(allowed(write('/etc/profile')), false);
    assert.equal(allowed(edit('/workspace/../opt/factorial/agent-runtime/host.mjs')), false);
    assert.equal(allowed(write('/workspace-other/x')), false);
    assert.equal(allowed(notebook('/tmp/n.ipynb')), false);
    assert.equal(allowed(edit('/workspace/.claude/settings.json')), false);
    assert.equal(allowed(write()), false);
  });

  it('denies pushing and calling GitHub from the shell', () => {
    assert.equal(allowed(shell('git push origin HEAD')), false);
    assert.equal(allowed(shell('cd repo && git -C . push --force')), false);
    assert.equal(allowed(shell('gh api repos/x/y')), false);
    assert.equal(allowed(shell('gh auth status')), false);
  });

  it('allows ordinary shell commands and other tools', () => {
    assert.equal(allowed(shell('git commit -m "Add the push notification"')), true);
    assert.equal(allowed(shell('quiet npm test')), true);
    assert.equal(allowed(other('Read')), true);
  });

  it('gives the model a reason it can read', () => {
    const decision = decideToolUse('/workspace', shell('git push'));
    assert.ok(!decision.allow && /orchestrator pushes/.test(decision.reason));
  });
});

describe('decideToolUse for the plan subagent', () => {
  const plan = (call: ToolCall) => decideToolUse('/workspace', call, 'plan');

  it('lets it write only the two plan files', () => {
    assert.equal(plan(write('/workspace/plan.json')).allow, true);
    assert.equal(plan(write('/workspace/plan.md')).allow, true);
    assert.equal(plan(write('plan.json')).allow, true);
    for (const file of ['/workspace/notes.md', '/workspace/repo/plan.json', '/workspace/plan.json.bak', '/workspace/repo/../plan.md/x']) {
      assert.equal(plan(write(file)).allow, false, file);
    }
  });

  it('refuses it edits and notebooks, even on the plan files', () => {
    assert.equal(plan(edit('/workspace/plan.json')).allow, false);
    assert.equal(plan(notebook('/workspace/plan.md')).allow, false);
  });

  it('leaves the builder and the explore subagent to the general rules', () => {
    assert.equal(decideToolUse('/workspace', write('/workspace/repo/a.ts')).allow, true);
    assert.equal(decideToolUse('/workspace', write('/workspace/repo/a.ts'), 'explore').allow, true);
  });
});

describe('decideReviewerToolUse', () => {
  const reviewer = (call: ToolCall) => decideReviewerToolUse('/workspace', call, 'Write').allow;
  const bash = (command: string) => reviewer(shell(command));

  it('lets it write and edit only review.json', () => {
    assert.equal(reviewer(write('/workspace/review.json')), true);
    assert.equal(reviewer(edit('review.json')), true);
    for (const file of ['/workspace/repo/src/a.ts', '/workspace/notes.md', '/workspace/repo/review.json', '/tmp/review.json']) {
      assert.equal(reviewer(write(file)), false, file);
    }
    assert.equal(reviewer(notebook('/workspace/review.json')), false);
    assert.equal(reviewer(write()), false);
  });

  it("names the harness's file-writing tool in its reason", () => {
    const decision = decideReviewerToolUse('/workspace', write('/workspace/a.ts'), 'write');
    assert.ok(!decision.allow && decision.reason.endsWith('Write the review with the write tool.'));
  });

  it('allows reading and searching from the shell', () => {
    for (const command of [
      'cd /workspace/repo && git log --oneline -5 && git show --stat HEAD',
      "git grep -n 'git commit' -- src | head",
      'grep -rn "=>" src/a.ts 2>/dev/null | head -20',
      'grep -n cp src/a.ts',
      'sed -n 10,40p src/a.ts 2>&1',
      'git diff --stat main...HEAD >/dev/null && echo same',
      "jq -e '.schemaVersion == 1' /workspace/review.json",
      'git branch -a',
    ]) {
      assert.equal(bash(command), true, command);
    }
  });

  it('denies writes, git changes and installs from the shell', () => {
    for (const command of [
      'echo x > /workspace/repo/a.ts',
      "jq . /workspace/review.json >> out.json",
      'cat a | tee /workspace/review.json',
      'cd repo && git commit -am fix',
      'git -C /workspace/repo checkout main',
      'git stash',
      'npm install left-pad',
      'npm ci',
      "sed -i 's/a/b/' src/a.ts",
      'rm -rf /workspace/repo/src',
      'find . -name x | xargs rm',
      'ls; touch x',
      'bash -c "echo x > a"',
      'git push origin HEAD',
      'gh api repos/x/y',
    ]) {
      assert.equal(bash(command), false, command);
    }
  });

  it('allows reading any file', () => {
    assert.equal(reviewer(other('Read')), true);
    assert.equal(reviewer(other('Grep')), true);
  });
});

describe('writesByRedirection', () => {
  it('ignores quoted text and harmless redirections', () => {
    assert.equal(writesByRedirection("grep -n '=> {' a.ts"), false);
    assert.equal(writesByRedirection('cmd 2>/dev/null >&2 2>&1'), false);
    assert.equal(writesByRedirection('cmd > /dev/null'), false);
  });

  it('finds a redirection to a file', () => {
    assert.equal(writesByRedirection('cmd >out'), true);
    assert.equal(writesByRedirection('cmd 2> err.log'), true);
    assert.equal(writesByRedirection("echo '>' > a"), true);
  });
});
