import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ROUTE_FILE, routeFileContent } from '@factorial/roles';

import { PI_TOOLS } from './pi/tools.ts';
import { PLAN_AGENT } from './agents.ts';
import { PROPOSAL_DONE, PROPOSAL_READ_ONLY, proposalRule, proposalStopCheck, seededRoute } from './proposal.ts';
import { HOST_ROLES } from './roles.ts';

const planStep = (id: string) => ({ id, description: `Do ${id}.`, files: ['src/a.ts'], verification: 'npm test passes' });
const validPlan = JSON.stringify({ schemaVersion: 1, summary: 'Add a test.', steps: [planStep('add-test')], tests: { run: ['npm test'], add: [] }, risks: [], openQuestions: [] });

/** A workspace with a repository in it, seeded for a route. */
function workspace(route?: 'propose' | 'change'): { workspace: string; repository: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'proposal-'));
  const repository = path.join(dir, 'repo');
  mkdirSync(repository);
  if (route) writeFileSync(path.join(dir, ROUTE_FILE), routeFileContent(route));
  return { workspace: dir, repository };
}

describe('the seeded route', () => {
  it('is propose only when the seed says so', () => {
    assert.equal(seededRoute(workspace('propose').workspace), 'propose');
    assert.equal(seededRoute(workspace('change').workspace), 'change');
    assert.equal(seededRoute(workspace().workspace), 'change');
  });
});

describe('proposalRule', () => {
  const dirs = workspace('propose');

  it('lets file tools write the plan files and the notes, never the repository or the route file', () => {
    for (const file of ['plan.json', 'plan.md', 'notes.md']) {
      assert.equal(proposalRule(dirs, { kind: 'write', path: path.join(dirs.workspace, file) }), undefined, file);
    }
    assert.equal(proposalRule(dirs, { kind: 'edit', path: path.join(dirs.repository, 'src/a.ts') }), PROPOSAL_READ_ONLY);
    assert.equal(proposalRule(dirs, { kind: 'write', path: path.join(dirs.workspace, ROUTE_FILE) }), PROPOSAL_READ_ONLY);
  });

  it('keeps the shell to reading', () => {
    assert.equal(proposalRule(dirs, { kind: 'shell', command: 'rg -n "plan" src' }), undefined);
    assert.equal(proposalRule(dirs, { kind: 'shell', command: 'git log --oneline -5' }), undefined);
    for (const command of ['git commit -am x', 'npm install left-pad', 'echo x > src/a.ts', 'rm -rf src', "sed -i 's/a/b/' src/a.ts"]) {
      assert.equal(proposalRule(dirs, { kind: 'shell', command }), PROPOSAL_READ_ONLY, command);
    }
  });
});

describe('the builder on the propose route', () => {
  it('closes every tool once plan.json is valid and plan.md is written, and says to end the run', () => {
    const dirs = workspace('propose');
    const notes: string[] = [];
    const policy = HOST_ROLES.builder.session(dirs, (message) => notes.push(message), PI_TOOLS);
    writeFileSync(path.join(dirs.workspace, 'plan.json'), validPlan);
    // plan.md not yet written: the plan subagent may still write it.
    assert.equal(policy.afterFileChange?.(path.join(dirs.workspace, 'plan.json')), undefined);
    assert.deepEqual(policy.decide({ kind: 'write', path: path.join(dirs.workspace, 'plan.md') }, PLAN_AGENT), { allow: true });
    writeFileSync(path.join(dirs.workspace, 'plan.md'), '# Plan\n\nAdd a test.\n');
    assert.equal(policy.afterFileChange?.(path.join(dirs.workspace, 'plan.md')), PROPOSAL_DONE);
    assert.deepEqual(policy.decide({ kind: 'shell', command: 'ls' }), { allow: false, reason: PROPOSAL_DONE });
    assert.deepEqual(policy.decide({ kind: 'other', name: 'read' }), { allow: false, reason: PROPOSAL_DONE });
    assert.equal(policy.beforeStop(), undefined);
    assert.ok(notes.includes('proposal run'));
  });

  it('refuses a change to the repository before the plan is done', () => {
    const dirs = workspace('propose');
    const policy = HOST_ROLES.builder.session(dirs, () => {}, PI_TOOLS);
    assert.deepEqual(policy.decide({ kind: 'edit', path: path.join(dirs.repository, 'a.ts') }), { allow: false, reason: PROPOSAL_READ_ONLY });
    assert.deepEqual(policy.decide({ kind: 'shell', command: 'git commit -m x' }), { allow: false, reason: PROPOSAL_READ_ONLY });
  });

  it('sends the builder back while there is no plan, without asking for a summary, then lets it stop', () => {
    const dirs = workspace('propose');
    const policy = HOST_ROLES.builder.session(dirs, () => {}, PI_TOOLS);
    assert.match(policy.beforeStop() ?? '', /plan\.json/);
    assert.doesNotMatch(policy.beforeStop() ?? 'x', /summary\.md/);
    // MAX_REPORT_CHECKS reached: the run ends, and Collect reports the invalid plan.
    assert.equal(policy.beforeStop(), undefined);
  });

  it('starts from the request as given, without a plan brief', () => {
    const dirs = workspace('propose');
    writeFileSync(path.join(dirs.workspace, 'plan.json'), validPlan);
    const policy = HOST_ROLES.builder.session(dirs, () => {}, PI_TOOLS);
    assert.equal(policy.prompt('Plan this.'), 'Plan this.');
  });

  it('leaves a change run as it was: the repository is writable and an existing plan is briefed', () => {
    const dirs = workspace();
    writeFileSync(path.join(dirs.workspace, 'plan.json'), validPlan);
    const policy = HOST_ROLES.builder.session(dirs, () => {}, PI_TOOLS);
    assert.deepEqual(policy.decide({ kind: 'edit', path: path.join(dirs.repository, 'a.ts') }), { allow: true });
    assert.notEqual(policy.prompt('Build this.'), 'Build this.');
  });
});

describe('proposalStopCheck', () => {
  it('asks for plan.md when only plan.json is written', () => {
    const dirs = workspace('propose');
    writeFileSync(path.join(dirs.workspace, 'plan.json'), validPlan);
    assert.match(proposalStopCheck(dirs.workspace, () => {})() ?? '', /plan\.md is missing/);
  });
});
