import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';
import type { DependencyChanges } from '../lib/dependency-changes.ts';

import {
  closingReference,
  impactSection,
  planSection,
  pullRequestBody,
  reviewFocusSection,
  reviewSection,
  sectionFromSummary,
  splitPlanSteps,
  testsSection,
  WORD_CAPS,
} from './pr-body.ts';

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

const SECTION_ORDER = ['## Summary', '## Impact', '## Review focus', '## Tests', '## Plan', '<summary>Run details</summary>'];

const orderOk = (body: string, order: string[]): boolean => {
  let at = -1;
  for (const heading of order) {
    const next = body.indexOf(heading);
    if (next === -1 || next < at) return false;
    at = next;
  }
  return true;
};

const builderSummary = [
  '# Done',
  '',
  'Added validation.',
  '',
  '## Summary',
  '',
  'Added validation to the quantity handler so bad input is rejected.',
  '',
  '## Behaviour impact',
  '',
  'Invalid quantities are now rejected with a 400.',
  '',
  '## Breaking changes',
  '',
  'None.',
  '',
  '## Uncertainties',
  '',
  'Could not verify the 400 shape against the client.',
  '',
  '## Not tested',
  '',
  'The client-side error rendering.',
  '',
  '## Plan steps',
  '',
  '- validate-quantity: done',
  '- handler-tests: done',
].join('\n');

const plan = {
  summary: 'Reject bad quantities.',
  steps: [
    { id: 'validate-quantity', description: 'Check quantity is a positive integer.' },
    { id: 'handler-tests', description: 'Add tests for the handler.' },
  ],
  openQuestions: [],
  testsAdd: ['handler rejects a zero quantity'],
};

const test = { runUrl: 'https://x/run/1', outcome: 'success' };
const headSha = 'f'.repeat(40);

const reviewDigest = () => ({
  verdict: 'request-changes' as const,
  scores: { correctness: 2, completeness: 3, tests: 2, safety: 4 },
  summary: 'The check runs after the write.',
  findings: [
    { path: '.github/workflows/ci.yml', severity: 'high' as const, body: 'Added by the orchestrator: this changes a workflow.' },
    { path: 'src/a.ts', line: 18, severity: 'high' as const, body: 'Move the check\nabove the write.' },
    { path: 'src/a.test.ts', severity: 'medium' as const, body: 'Assert nothing is written.' },
  ],
  totalFindings: 3,
});

describe('sectionFromSummary', () => {
  it('extracts a section up to the next heading and caps it with an ellipsis', () => {
    assert.equal(sectionFromSummary('## Summary\n\nFirst line.\nSecond line.\n\n## Other\n\nnope', '## Summary', 50), 'First line.\nSecond line.');
    const capped = sectionFromSummary(`## Not tested\n\n${'word '.repeat(80)}`, '## Not tested', WORD_CAPS.notTested);
    assert.ok(capped!.endsWith(' …'));
    assert.equal(capped!.split(/\s+/).length, WORD_CAPS.notTested + 1);
  });

  it('is undefined when the section is missing or blank', () => {
    assert.equal(sectionFromSummary('# Done', '## Summary', 100), undefined);
    assert.equal(sectionFromSummary('## Summary\n\n   \n', '## Summary', 100), undefined);
  });
});

describe('pullRequestBody: a plain code change', () => {
  const body = pullRequestBody(ctx, builderSummary, test, headSha, plan, { ok: true, review: reviewDigest() });

  it('renders all sections in the fixed order with nothing repeated', () => {
    for (const heading of SECTION_ORDER) assert.ok(body.includes(heading), `missing ${heading}`);
    assert.ok(orderOk(body, SECTION_ORDER));
    assert.ok(body.includes('## Automated review'));
    assert.equal(body.match(/validate-quantity/g)?.length, 2, 'once in a departure-free check, once in the collapsed list');
    assert.ok(body.trimEnd().endsWith('</details>'));
  });

  it('puts the closing reference under the summary and the metadata in Run details', () => {
    assert.match(body, /so bad input is rejected\.\n\nCloses #7\n\n## Impact/);
    assert.ok(body.indexOf('Closes #7') < body.indexOf('## Impact'));
    assert.match(body, /\| Work item \| \[github-issue 7\]\(https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7\) \|/);
    assert.match(body, /\| Head \| `ffffffffffff` \|/);
    assert.match(body, /\| Artefacts \| `7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c\/1\/` \|/);
  });

  it('shows None in the impact bullets that do not apply', () => {
    const impact = impactSection({ builderSummary });
    assert.match(impact, /- \*\*Behaviour:\*\* Invalid quantities are now rejected with a 400\./);
    assert.match(impact, /- \*\*Deploy:\*\* None — no CloudFormation template changes/);
    assert.match(impact, /- \*\*Contracts:\*\* None/);
    assert.match(impact, /- \*\*Dependencies:\*\* None/);
    assert.match(impact, /- \*\*Breaking changes:\*\* None\./);
  });

  it('renders the tests section with the run link and the plan tests', () => {
    const section = testsSection(test, plan, builderSummary);
    assert.match(section, /Result: \[success\]\(https:\/\/x\/run\/1\)/);
    assert.match(section, /- handler rejects a zero quantity/);
    assert.match(section, /The client-side error rendering\./);
  });
});

describe('pullRequestBody: a new dependency', () => {
  const deps: DependencyChanges = { added: [{ name: 'zod', licence: 'MIT' }, { name: 'left-pad' }], removed: ['old-pkg'] };

  it('names each package and its lockfile licence in the Dependencies bullet', () => {
    const impact = impactSection({ builderSummary, dependencies: deps });
    assert.match(impact, /- \*\*Dependencies:\*\* - added `zod` \(MIT\)\n- added `left-pad` \(licence not recorded in the lockfile\)\n- removed `old-pkg`/);
  });
});

describe('pullRequestBody: a workflow or foundation change', () => {
  const changedPaths = ['templates/00-foundation.yml', '.github/workflows/ci.yml'];

  it('names the human deploy step and leads the review focus with the sensitive path', () => {
    const impact = impactSection({ builderSummary, changedPaths });
    assert.match(impact, /- \*\*Deploy:\*\* `templates\/00-foundation\.yml` — a foundation deploy is needed; review the diff before it runs/);
  });

  it('is deployed by the workflow when only a numbered template changes', () => {
    assert.match(impactSection({ builderSummary, changedPaths: ['templates/30-orchestration.yml'] }), /deployed by the deploy workflow after merge/);
  });

  it('lists the sensitive paths first in the review focus, with their reasons', () => {
    const section = reviewFocusSection({
      builderSummary,
      sensitive: [{ path: 'templates/00-foundation.yml', reason: 'changes the foundation stack' }],
      plan,
    });
    assert.match(section, /^## Review focus\n\n- `templates\/00-foundation\.yml` — changes the foundation stack/);
    assert.match(section, /## Uncertainties/);
    assert.ok(section.split('\n').filter((line) => line.startsWith('- ')).length <= 5);
  });
});

describe('pullRequestBody: plan departures', () => {
  const departed = builderSummary.replace('- handler-tests: done', '- handler-tests: skipped, the tests existed already');

  it('lists departures in the open and the full untruncated step list collapsed', () => {
    const body = pullRequestBody(ctx, departed, test, headSha, plan);
    assert.match(body, /## Plan\n\n- handler-tests: skipped, the tests existed already/);
    assert.doesNotMatch(body, /- validate-quantity: done\n- handler-tests: skipped/);
    const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
    assert.match(details, /1\. `validate-quantity`: Check quantity is a positive integer\./);
    assert.doesNotMatch(details, /…/);
    assert.equal(body.match(/<summary>Plan steps \(2\)<\/summary>/g)?.length, 1);
  });

  it('reports unmatched builder lines as departures', () => {
    const section = planSection(plan, '- validate-quantity: done\n- mystery: done');
    assert.match(section, /- mystery: done \(reported, matches no plan step\)/);
  });

  it('says so when every step was done as planned', () => {
    const body = pullRequestBody(ctx, builderSummary, test, headSha, plan);
    assert.match(body, /## Plan\n\nAll 2 steps were done as planned\./);
  });
});

describe('pullRequestBody: the automated review', () => {
  it('shows the verdict and four scores on one line, high findings in the open', () => {
    const body = pullRequestBody(ctx, builderSummary, test, headSha, plan, { ok: true, review: reviewDigest() });
    assert.match(body, /\*\*Request changes\*\* · correctness 2\/5 · completeness 3\/5 · tests 2\/5 · safety 4\/5/);
    assert.match(body, /## Automated review\n\n[^]*?\*\*High severity\*\*/);
    assert.match(body, /- `src\/a\.ts:18`: Move the check above the write\./);
    assert.match(body, /<summary>1 other finding<\/summary>/);
  });

  it('shortens reviewer findings to path pointers in the review focus', () => {
    const section = reviewFocusSection({ builderSummary, review: reviewDigest() });
    assert.match(section, /`src\/a\.ts:18` — Move the check above the write\. \(high, from the automated review\)/);
    assert.ok(section.split('\n').filter((l) => l.startsWith('- ')).length <= 5);
  });

  it('renders a failed review as the fixed sentence, without quoting errors', () => {
    for (const outcome of [null, { ok: false as const, errors: ['review.json /x has unexpected property "@everyone"'] }]) {
      const body = pullRequestBody(ctx, builderSummary, test, headSha, plan, outcome);
      assert.match(body, /_The automated review did not complete\. It is advisory, so the pull request was opened anyway/);
      assert.doesNotMatch(body, /everyone/);
    }
  });

  it('is absent for runs before the Review stage, and the review focus still renders', () => {
    const body = pullRequestBody(ctx, builderSummary, test, headSha, plan);
    assert.doesNotMatch(body, /## Automated review/);
    assert.ok(body.includes('## Review focus'));
  });

  it('says when nothing needs attention', () => {
    const section = reviewFocusSection({ builderSummary: '# Done', plan: { ...plan, openQuestions: [] } });
    assert.match(section, /_Nothing needs particular attention: no sensitive paths changed and the review raised no findings\._/);
  });
});

describe('pullRequestBody: a builder summary with missing sections', () => {
  it('uses placeholders and None without crashing', () => {
    const body = pullRequestBody(ctx, '   ', {}, headSha, plan);
    assert.match(body, /_The builder did not write a summary\._/);
    assert.match(body, /- \*\*Behaviour:\*\* None/);
    assert.match(body, /- \*\*Breaking changes:\*\* None/);
    assert.match(body, /Result: not run/);
    assert.match(body, /Nothing was flagged as untested by the builder\./);
    // No builder report on the steps: each is listed as a departure, and the plan still renders.
    assert.match(body, /- `validate-quantity` — not reported by the builder/);
    assert.ok(body.includes('<summary>Plan steps (2)</summary>'));
    const body2 = pullRequestBody(ctx, builderSummary, {}, headSha, plan);
    assert.match(body2, /Result: not run/);
    assert.match(body2, /_The plan added no tests\._/);
    assert.match(body2, /## Plan\n\nAll 2 steps were done as planned\./);
  });

  it('caps a section that busts its word limit', () => {
    const long = builderSummary.replace('Invalid quantities are now rejected with a 400.', 'word '.repeat(120));
    const impact = impactSection({ builderSummary: long });
    const behaviour = impact.split('- **Behaviour:** ')[1]?.split('\n')[0] ?? '';
    assert.ok(behaviour.endsWith(' …'));
    assert.equal(behaviour.split(/\s+/).length, WORD_CAPS.behaviour + 1);
  });
});

describe('pullRequestBody: a #84-shaped summary', () => {
  const dense = [
    '## What changed',
    ...Array.from({ length: 12 }, (_, i) => `- thing ${i + 1} was changed`),
    '',
    'The plan took a layered approach: first the validation layer was reconsidered in its entirety, then the handler',
    'was rewritten around it, then the tests were reorganised so that each case exercises one layer in isolation,',
    'which required a small amount of restructuring of the fixtures shared between the two suites.',
    '',
    '## Plan steps',
    '',
    '- validate-quantity: done',
    '- handler-tests: done',
    '- validate-quantity: done',
    '- handler-tests: done',
  ].join('\n');

  it('puts summary, impact and review focus above the run details, with the step list once', () => {
    const body = pullRequestBody(ctx, dense, test, headSha, plan, { ok: true, review: reviewDigest() }, { changedPaths: ['src/a.ts'] });
    assert.ok(orderOk(body, [...SECTION_ORDER.slice(0, 3), '## Automated review', ...SECTION_ORDER.slice(3)]));
    assert.ok(body.indexOf('## Impact') < body.indexOf('## Review focus'));
    assert.ok(body.indexOf('## Review focus') < body.indexOf('<summary>Run details</summary>'));
    assert.equal(body.match(/<summary>Plan steps \(2\)<\/summary>/g)?.length, 1);
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

describe('splitPlanSteps', () => {
  it('takes the builder step report out and leaves the rest', () => {
    const { rest, steps } = splitPlanSteps(builderSummary);
    assert.equal(steps, '- validate-quantity: done\n- handler-tests: done');
    assert.doesNotMatch(rest, /Plan steps/);
    assert.match(rest, /## Not tested/);
  });

  it('leaves a summary without a step report unchanged', () => {
    assert.deepEqual(splitPlanSteps('# Done'), { rest: '# Done' });
  });
});

