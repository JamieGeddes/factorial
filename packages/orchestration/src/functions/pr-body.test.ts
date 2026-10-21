import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import { closingReference, planSection, pullRequestBody, splitPlanSteps } from './pr-body.ts';

const ctx: WorkContext = {
  workItem: {
    schemaVersion: 1,
    id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    title: 'Fix typo',
    body: '',
    requestedBy: 'JamieGeddes',
    createdAt: '2026-10-17T09:00:00Z',
  },
  sessionId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
  baseCommit: 'b'.repeat(40),
  factorialVersion: '0123456789abcdef0123456789abcdef01234567',
  attempt: 1,
  artefactPrefix: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/1/',
};

describe('pullRequestBody', () => {
  it('leads with the summary and ends with the evidence table', () => {
    const body = pullRequestBody(ctx, '# Done\n\nFixed it.', { runUrl: 'https://x/run/1', outcome: 'success' }, 'f'.repeat(40));
    assert.ok(body.startsWith('# Done\n\nFixed it.'));
    assert.match(body, /\| Work item \| \[github-issue 7\]\(https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7\) \|/);
    assert.match(body, /\| Requested by \| @JamieGeddes \|/);
    assert.match(body, /\| Tests \| \[success\]\(https:\/\/x\/run\/1\) \|/);
    assert.match(body, /\| Head \| `ffffffffffff` \|/);
    assert.match(body, /\| Built by \| Factorial `0123456789ab` \|/);
    assert.match(body, /\| Artefacts \| `7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c\/1\/` \|/);
    // the closing reference sits between the summary and the evidence
    assert.match(body, /Fixed it\.\n\nCloses #7\n\n---\n/);
  });

  it('says so when the agent wrote no summary and tests did not run', () => {
    const body = pullRequestBody(ctx, '   ', {}, 'a'.repeat(40));
    assert.match(body, /_The agent did not write a summary\._/);
    assert.match(body, /\| Tests \| not run \|/);
  });
});

describe('closingReference', () => {
  it('uses the short form for an issue in the repository being changed', () => {
    assert.equal(closingReference(ctx.workItem), 'Closes #7');
  });

  it('uses the owner/repo form for an issue elsewhere', () => {
    const other = { ...ctx.workItem, repository: { provider: 'github' as const, owner: 'JamieGeddes', name: 'other-repo' } };
    assert.equal(closingReference(other), 'Closes JamieGeddes/factorial#7');
  });

  it('is absent for other triggers or an unrecognised url', () => {
    assert.equal(closingReference({ ...ctx.workItem, source: { type: 'jira-ticket', id: 'FAC-1', url: 'https://x.atlassian.net/browse/FAC-1' } }), undefined);
    assert.equal(closingReference({ ...ctx.workItem, source: { ...ctx.workItem.source, url: 'https://evil.example/JamieGeddes/factorial/issues/7' } }), undefined);
  });
});

describe('plan in the pull request body', () => {
  const plan = {
    summary: 'Reject bad quantities.',
    steps: [
      { id: 'validate-quantity', description: 'Check quantity is a positive integer.' },
      { id: 'handler-tests', description: 'Add tests.' },
    ],
  };

  it("takes the builder's step report out of the summary", () => {
    const summary = '# Done\n\nAdded validation.\n\n## Plan steps\n\n- validate-quantity: done\n- handler-tests: changed, reason\n\n## Verification\n\nnpm test';
    const { rest, steps } = splitPlanSteps(summary);
    assert.equal(steps, '- validate-quantity: done\n- handler-tests: changed, reason');
    assert.equal(rest, '# Done\n\nAdded validation.\n\n## Verification\n\nnpm test');
  });

  it('leaves a summary without a step report unchanged', () => {
    assert.deepEqual(splitPlanSteps('# Done'), { rest: '# Done' });
  });

  it('lists the plan steps and says when the builder did not report on them', () => {
    const section = planSection(plan, undefined);
    assert.match(section, /^## Plan\n\nReject bad quantities\.\n\n1\. `validate-quantity`: Check quantity/);
    assert.match(section, /_The builder did not report on the plan's steps\._/);
  });

  it('matches the builder\u0027s reported lines to the plan steps by id', () => {
    const section = planSection(plan, '- validate-quantity: done\n- `handler-tests`: changed, reason');
    assert.match(section, /1\. `validate-quantity`: Check quantity is a positive integer\.\n   - validate-quantity: done/);
    assert.match(section, /2\. `handler-tests`: Add tests\.\n   - `handler-tests`: changed, reason/);
  });

  it('lists reported lines that match no plan step id', () => {
    const section = planSection(plan, '- validate-quantity: done\n- mystery-step: done');
    assert.match(section, /not in the plan: - mystery-step: done/);
  });

  it('puts the plan after the summary and before the evidence table', () => {
    const body = pullRequestBody(ctx, '# Done\n\n## Plan steps\n\n- validate-quantity: done', {}, 'f'.repeat(40), plan);
    assert.ok(body.indexOf('# Done') < body.indexOf('## Plan'));
    assert.ok(body.indexOf('## Plan') < body.indexOf('| Work item |'));
    assert.match(body, /### How the builder followed it\n\n- validate-quantity: done/);
    assert.equal(body.match(/## Plan steps/g), null);
  });

  it('has no plan section without a plan', () => {
    assert.doesNotMatch(pullRequestBody(ctx, '# Done', {}, 'f'.repeat(40)), /## Plan/);
  });
});
