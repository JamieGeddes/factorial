import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import type { Plan } from '@factorial/plan';

import type { PrFacts } from '../lib/pr-facts.ts';

import type { ReworkContext } from '@factorial/workitem';

import { agentText, closingReference, noMentions, pullRequestBody, reworkComment, safeLogin, type BodyExtras } from './pr-body.ts';

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
  threadKey: 'jamiegeddes/factorial#factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  sessionId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
  baseCommit: 'b'.repeat(40),
  factorialVersion: '0123456789abcdef0123456789abcdef01234567',
  attempt: 1,
  artefactPrefix: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/1/',
};

const HEAD = 'f'.repeat(40);
const PASS: { runUrl?: string; outcome?: string } = { runUrl: 'https://x/run/1', outcome: 'success' };

const SECTIONS = ['## Summary', '## Impact', '## Review focus', '## Automated review', '## Tests', '## Plan', '<summary>Run details</summary>'];

const plan: Plan = {
  schemaVersion: 1,
  summary: 'Do the thing.',
  steps: [
    { id: 'one', description: 'First step, described in full\nover two lines.', files: [], verification: 'v' },
    { id: 'two', description: 'Second step.', files: [], verification: 'v' },
  ],
  tests: { run: [], add: ['Test the thing.'] },
  risks: [],
  openQuestions: ['Is X acceptable?'],
};

const noFacts: PrFacts = { sensitive: [], contracts: [], testFiles: [], dependencies: [], deploy: { configured: true, notes: [], humanSteps: [] } };

const summaryMd = (steps = '- one: done\n- two: done'): string =>
  [
    '## Summary',
    'Adds the thing so operators can see it.',
    '',
    '## Behaviour impact',
    'Operators now see the thing.',
    '',
    '## Breaking changes',
    'None.',
    '',
    '## Uncertainties',
    '- Assumed the thing is wanted.',
    '',
    '## Not tested',
    '- The live deploy.',
    '',
    '## Plan steps',
    steps,
  ].join('\n');

const render = (summary: string, extras: BodyExtras = { fullPlan: plan, facts: noFacts, review: undefined }, test = PASS): string =>
  pullRequestBody(ctx, summary, test, HEAD, extras);

/** Section headings appear in the fixed order, once each. */
function assertOrder(body: string): void {
  let last = -1;
  for (const marker of SECTIONS) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `${marker} should come after the previous section`);
    assert.equal(body.indexOf(marker, at + 1), -1, `${marker} appears once`);
    last = at;
  }
}

const section = (body: string, heading: string): string => {
  const start = body.indexOf(heading);
  const next = body.slice(start + heading.length).search(/\n## |\n<details>\n<summary>Run details/);
  return body.slice(start, next === -1 ? undefined : start + heading.length + next).trimEnd();
};

describe('pullRequestBody: a plain code change', () => {
  const body = render(summaryMd());

  it('has every section in order, with the closing reference under the summary', () => {
    assertOrder(body);
    assert.match(section(body, '## Summary'), /Adds the thing so operators can see it\.\n\nCloses #7$/);
  });

  it('fills every impact bullet, with None where nothing applies', () => {
    const impact = section(body, '## Impact');
    assert.match(impact, /- \*\*Behaviour:\*\* Operators now see the thing\./);
    assert.match(impact, /- \*\*Deploy:\*\* None/);
    assert.match(impact, /- \*\*Contracts:\*\* None/);
    assert.match(impact, /- \*\*Dependencies:\*\* None/);
    assert.match(impact, /- \*\*Breaking changes or migration:\*\* None\./);
  });

  it('ranks the builder uncertainties and plan questions in review focus', () => {
    assert.match(section(body, '## Review focus'), /1\. Builder was unsure: Assumed the thing is wanted\.\n2\. Open question in the plan: Is X acceptable\?$/);
  });

  it('shows the test result, and the plan only as planned', () => {
    const tests = section(body, '## Tests');
    assert.match(tests, /- \*\*Result:\*\* \[success\]\(https:\/\/x\/run\/1\)/);
    assert.match(tests, /- \*\*Test files added or changed:\*\* none among the changed files/);
    assert.match(tests, /- \*\*Not tested:\*\* The live deploy\./);
    assert.match(tests, /Planned tests \(from the plan, not a report of what was added\)/);
  });

  it('says every step was done and lists the steps once, untruncated, in details', () => {
    const planPart = section(body, '## Plan');
    assert.match(planPart, /Every step was done as planned \(2 steps\)\./);
    assert.match(planPart, /<summary>All plan steps<\/summary>/);
    assert.equal(body.split('`one`').length, 2);
    assert.match(planPart, /First step, described in full over two lines\./);
  });

  it('puts the metadata table in details at the end, without the test row', () => {
    const details = body.slice(body.indexOf('<summary>Run details</summary>'));
    assert.match(details, /\| Work item \| \[github-issue 7\]\(https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7\) \|/);
    assert.match(details, /\| Requested by \| @JamieGeddes \|/);
    assert.match(details, /\| Head \| `ffffffffffff` \|/);
    assert.match(details, /\| Built by \| Factorial `0123456789ab` \|/);
    assert.match(details, /\| Artefacts \| `7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c\/1\/` \|/);
    assert.doesNotMatch(details, /\| Tests \|/);
    assert.ok(details.trimEnd().endsWith('</details>'));
  });

  it('says tests did not run when there is no run', () => {
    assert.match(render(summaryMd(), undefined, {}), /- \*\*Result:\*\* not run/);
  });

  it('keeps the part above the details short', () => {
    assert.ok(body.split('\n').length < 70);
  });
});

describe('pullRequestBody: a new dependency', () => {
  it('names the package, where it was added and its licence; removals too', () => {
    const facts: PrFacts = {
      ...noFacts,
      dependencies: [
        { name: 'left-pad', change: 'added', version: '^1.3.0', dev: false, file: 'packages/a/package.json', licence: 'MIT' },
        { name: 'old', change: 'removed', version: '1', dev: true, file: 'package.json' },
      ],
    };
    const body = render(summaryMd(), { fullPlan: plan, facts });
    assertOrder(body);
    assert.match(section(body, '## Impact'), /- \*\*Dependencies:\*\* added `left-pad` `\^1\.3\.0` in `packages\/a\/package\.json`, licence per the lockfile: `MIT`; removed `old` \(dev\) from `package\.json`/);
  });

  it('keeps values the branch controls inside their code spans', () => {
    const facts: PrFacts = {
      ...noFacts,
      testFiles: ['a`</details>\n## Pwned.test.ts'],
      dependencies: [{ name: 'x`y', change: 'added', version: '1`\n# Heading', dev: false, file: 'package.json', licence: 'MIT` [link](https://e.x)' }],
    };
    const body = render(summaryMd(), { fullPlan: plan, facts });
    assertOrder(body);
    assert.ok(!/^#+ (Heading|Pwned)/m.test(body));
    assert.match(section(body, '## Impact'), /added `x y` `1 # Heading` in `package\.json`, licence per the lockfile: `MIT  \[link\]\(https:\/\/e\.x\)`/);
    assert.match(section(body, '## Tests'), /`a <\/details> ## Pwned\.test\.ts`/);
  });
});

describe('pullRequestBody: a workflow or foundation change', () => {
  const facts: PrFacts = {
    ...noFacts,
    sensitive: [
      { path: '.github/workflows/ci.yml', reason: 'changes GitHub Actions, which run with the repository secrets' },
      { path: 'templates/foundation.yml', reason: 'changes the foundation stack' },
    ],
    contracts: ['contracts/a.json'],
    deploy: { configured: true, notes: ['CloudFormation templates change: `templates/foundation.yml`'], humanSteps: ['Deploy the foundation stack by hand: `templates/foundation.yml`'] },
  };
  const review = {
    ok: true as const,
    review: {
      verdict: 'comment' as const,
      scores: { correctness: 4, completeness: 4, tests: 3, safety: 3 },
      summary: 's',
      findings: [
        { path: '.github/workflows/ci.yml', severity: 'high' as const, body: 'Added by the orchestrator: this changes GitHub Actions.' },
        { path: 'src/a.ts', line: 3, severity: 'high' as const, body: 'Unchecked input.' },
      ],
      totalFindings: 2,
    },
  };
  const body = render(summaryMd(), { fullPlan: plan, facts, review });

  it('puts sensitive paths first in review focus, then the reviewer, and does not repeat the guard finding', () => {
    assertOrder(body);
    const focus = section(body, '## Review focus');
    assert.match(focus, /^## Review focus\n\n1\. `\.github\/workflows\/ci\.yml`: changes GitHub Actions/);
    assert.match(focus, /2\. `templates\/foundation\.yml`: changes the foundation stack\./);
    assert.match(focus, /3\. `contracts\/a\.json`: changes a contract/);
    assert.match(focus, /4\. `src\/a\.ts:3`: Unchecked input\./);
    assert.equal(focus.split('\n').filter((l) => /^\d\./.test(l)).length, 5);
    assert.doesNotMatch(section(body, '## Automated review'), /Added by the orchestrator/);
  });

  it('states the deploy impact and the human step, and lists the contract', () => {
    const impact = section(body, '## Impact');
    assert.match(impact, /- \*\*Deploy:\*\* CloudFormation templates change: `templates\/foundation\.yml`\. \*\*Human step needed:\*\* Deploy the foundation stack by hand/);
    assert.match(impact, /- \*\*Contracts:\*\* `contracts\/a\.json`/);
  });

  it('caps review focus at five items', () => {
    const many: PrFacts = { ...noFacts, sensitive: Array.from({ length: 9 }, (_, i) => ({ path: `p${i}`, reason: 'r' })) };
    const focus = section(render(summaryMd(), { fullPlan: plan, facts: many }), '## Review focus');
    assert.equal(focus.split('\n').filter((l) => /^\d\./.test(l)).length, 5);
  });
});

describe('pullRequestBody: package files that could not be read', () => {
  it('says dependencies are not determined rather than None', () => {
    const body = render(summaryMd(), { fullPlan: plan, facts: { ...noFacts, dependenciesUnknown: true } });
    assert.match(section(body, '## Impact'), /- \*\*Dependencies:\*\* Not determined \(the package files could not be read\)/);
  });
});

describe('pullRequestBody: deploy impact without settings', () => {
  it('says it is not determined rather than guessing, and when facts are missing', () => {
    const unconfigured: PrFacts = { ...noFacts, deploy: { configured: false, notes: [], humanSteps: [] } };
    assert.match(section(render(summaryMd(), { fullPlan: plan, facts: unconfigured }), '## Impact'), /- \*\*Deploy:\*\* Not determined \(no `\.factorial\/pr-body\.json`/);
    const impact = section(render(summaryMd(), { fullPlan: plan, facts: null }), '## Impact');
    assert.match(impact, /- \*\*Deploy:\*\* Not determined \(the review stage did not run\)/);
    assert.match(impact, /- \*\*Dependencies:\*\* Not determined/);
  });
});

describe('pullRequestBody: plan departures', () => {
  const body = render(summaryMd('- one: changed: split into two commits\n- two: skipped: already there'));

  it('lists only the departures in the open, with the builder note', () => {
    assertOrder(body);
    const planPart = section(body, '## Plan');
    const open = planPart.slice(0, planPart.indexOf('<details>'));
    assert.match(open, /2 of 2 steps departed from the plan or were not reported:/);
    assert.match(open, /- `one`: changed: split into two commits/);
    assert.match(open, /- `two`: skipped: already there/);
    assert.doesNotMatch(open, /Every step was done/);
  });

  it('does not read a status from elsewhere in a line', () => {
    const odd = render(summaryMd('- one: all good, nothing skipped\n- two: done'));
    assert.match(section(odd, '## Plan'), /- `one`: not reported/);
  });

  it('says so when the builder reported no steps', () => {
    assert.match(section(render('## Summary\nx'), '## Plan'), /_The builder did not report on the plan\'s 2 steps\._/);
  });

  it('falls back to the digest when the full plan is not available', () => {
    const body = render(summaryMd(), { plan: { summary: 's', steps: [{ id: 'one', description: 'cut…' }, { id: 'two', description: 'b' }] }, facts: noFacts });
    assert.match(section(body, '## Plan'), /`one` \(done\): cut…/);
  });

  it('says there was no plan for older runs', () => {
    assert.match(section(render(summaryMd(), { facts: noFacts }), '## Plan'), /_There was no plan for this run\._/);
  });
});

describe('pullRequestBody: review', () => {
  const digest = {
    verdict: 'request-changes' as const,
    scores: { correctness: 2, completeness: 3, tests: 2, safety: 4 },
    summary: 'The check runs after the write.',
    findings: [
      { path: 'src/a.ts', line: 18, severity: 'high' as const, body: 'Move the check\nabove the write.' },
      { path: 'src/b.ts', severity: 'medium' as const, body: 'Assert nothing is written.' },
      { path: 'src/c.ts', severity: 'low' as const, body: 'Naming.' },
    ],
    totalFindings: 3,
  };
  const body = render(summaryMd(), { fullPlan: plan, facts: noFacts, review: { ok: true, review: digest } });

  it('shows verdict and four scores on one line, high findings in the open, the rest collapsed', () => {
    assertOrder(body);
    const review = section(body, '## Automated review');
    assert.match(review, /^## Automated review\n\n\*\*Request changes\*\* · correctness 2\/5 · completeness 3\/5 · tests 2\/5 · safety 4\/5/);
    assert.match(review, /\*\*High severity\*\*\n\n- `src\/a\.ts:18`: Move the check above the write\./);
    assert.match(review, /<summary>2 other findings<\/summary>\n\n- \*\*medium\*\* `src\/b\.ts`: Assert nothing is written\./);
  });

  it('feeds high and medium findings into review focus, not low ones', () => {
    const focus = section(body, '## Review focus');
    assert.match(focus, /1\. `src\/a\.ts:18`: Move the check above the write\.\n2\. `src\/b\.ts`: Assert nothing is written\./);
    assert.doesNotMatch(focus, /Naming/);
  });

  it('says how many findings were left out of the digest', () => {
    const more = render(summaryMd(), { fullPlan: plan, review: { ok: true, review: { ...digest, totalFindings: 25 } } });
    assert.match(more, /_22 more findings in `review\/review\.json` in the artefacts\._/);
  });

  it('has no findings lists when there are none', () => {
    const clean = render(summaryMd(), { fullPlan: plan, review: { ok: true, review: { ...digest, verdict: 'approve', findings: [], totalFindings: 0 } } });
    const review = section(clean, '## Automated review');
    assert.match(review, /\*\*Approve\*\*/);
    assert.doesNotMatch(review, /High severity|<details>|more finding/);
  });
});

describe('pullRequestBody: a failed review', () => {
  it('says the review did not complete, without quoting its errors', () => {
    for (const review of [null, { ok: false as const, errors: ['review.json /x has unexpected property "@everyone"'] }]) {
      const body = render(summaryMd(), { fullPlan: plan, facts: noFacts, review });
      assertOrder(body);
      assert.match(section(body, '## Automated review'), /_The automated review did not complete\. It is advisory/);
      assert.doesNotMatch(body, /everyone/);
    }
  });

  it('says no review ran for runs before the stage', () => {
    assert.match(section(render(summaryMd()), '## Automated review'), /_No automated review ran for this pull request\._/);
  });
});

describe('pullRequestBody: a summary with missing sections', () => {
  it('uses placeholders for sections that are missing or empty', () => {
    const body = render('## Summary\n\n## Behaviour impact\n   \n## Plan steps\n- one: done');
    assertOrder(body);
    assert.match(section(body, '## Summary'), /_The builder did not write a summary\._/);
    const impact = section(body, '## Impact');
    assert.match(impact, /- \*\*Behaviour:\*\* _Not reported by the builder\._/);
    assert.match(impact, /- \*\*Breaking changes or migration:\*\* None/);
    assert.match(section(body, '## Tests'), /- \*\*Not tested:\*\* _Not reported by the builder\._/);
    assert.match(section(body, '## Review focus'), /Open question in the plan: Is X acceptable\?/);
  });

  it('shows a free-form summary in the summary slot, capped, with no headings of its own', () => {
    const body = render(`# Big heading\n\n${'word '.repeat(400)}`);
    assertOrder(body);
    const summary = section(body, '## Summary');
    assert.doesNotMatch(summary, /# Big heading/);
    assert.ok(summary.length < 900 + 40);
    assert.match(summary, /…/);
    assert.match(section(body, '## Impact'), /- \*\*Behaviour:\*\* _Not reported by the builder\._/);
    assert.match(section(body, '## Impact'), /- \*\*Breaking changes or migration:\*\* _Not reported by the builder\._/);
  });

  it('says nothing was written for an empty summary, and says nothing needs attention when it is so', () => {
    const body = pullRequestBody(ctx, '   ', {}, HEAD);
    assertOrder(body);
    assert.match(body, /_The builder did not write a summary\._/);
    assert.match(section(body, '## Review focus'), /Nothing needs particular attention\./);
  });
});

describe('length caps and dashes', () => {
  it('cuts each builder section to its cap and drops em and en dashes', () => {
    const long = 'x'.repeat(2000);
    const body = render(`## Summary\n${long} — end\n## Behaviour impact\n${long}\n## Breaking changes\n${long}\n## Uncertainties\n${[1, 2, 3, 4, 5, 6, 7].map((i) => `- ${long} ${i}`).join('\n')}\n## Plan steps\n- one: changed: ${long} – x`);
    assert.doesNotMatch(body, /[—–]/);
    assert.ok(section(body, '## Summary').length < 800 + 40);
    const impact = section(body, '## Impact');
    assert.ok(impact.split('\n').find((l) => l.startsWith('- **Behaviour'))!.length < 600 + 40);
    assert.ok(impact.split('\n').find((l) => l.startsWith('- **Breaking'))!.length < 600 + 60);
    const focus = section(body, '## Review focus');
    assert.equal(focus.split('\n').filter((l) => /^\d\./.test(l)).length, 5);
    for (const line of focus.split('\n').filter((l) => /^\d\./.test(l))) assert.ok(line.length < 300);
    assert.ok(body.split('\n').find((l) => l.startsWith('- `one`'))!.length < 400);
  });

  it('keeps agent text from closing the own blocks of the body or adding headings', () => {
    const text = agentText('## Heading\n</details> <summary>x</summary>', 200);
    assert.doesNotMatch(text, /<\/?details|<\/?summary|^#/);
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

describe('reworkComment', () => {
  const rework: ReworkContext = {
    kind: 'rework',
    pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
    branch: ctx.branch,
    baseBranch: 'main',
    previousWorkItemId: '1f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    cause: 'review',
    details: [
      { author: 'alice', path: 'src/a.ts', line: 3, body: 'Rename this.' },
      { author: 'bob', body: 'Add a test.' },
      { author: 'carol', body: 'And a doc.' },
    ],
  };
  const reworkCtx: WorkContext = { ...ctx, workItem: { ...ctx.workItem, context: rework }, reworkPoints: [{ author: 'alice', path: 'src/a.ts', line: 3 }, { author: 'bob' }, { author: 'carol' }] };
  const summary = `${summaryMd()}\n\n## Rework points\n- 1: Renamed it to \`b.ts\`.\n- 2: Added \`a.test.ts\`.\n`;

  it('answers each point by number, mentioning who raised it and where', () => {
    const text = reworkComment(reworkCtx, rework, summary, PASS, HEAD, { review: undefined, facts: noFacts });
    assert.match(text, /## Points raised\n\n1\. @alice on `src\/a\.ts:3`: Renamed it to `b\.ts`\.\n2\. @bob: Added `a\.test\.ts`\.\n3\. @carol: _Not reported by the builder\._/);
  });

  it('opens with the new head and the passing run, and says the description is unchanged', () => {
    const text = reworkComment(reworkCtx, rework, summary, PASS, HEAD, {});
    assert.match(text, /^Factorial has reworked this pull request after the review\. The branch is now at `ffffffffffff`, and the \[tests\]\(https:\/\/x\/run\/1\) passed on it\./);
    assert.match(text, /description above still describes the change as first opened/);
  });

  it('carries the summary, review, tests and run details, but no closing reference or plan', () => {
    const text = reworkComment(reworkCtx, rework, summary, PASS, HEAD, {});
    for (const marker of ['## Summary', '## Automated review', '## Tests', '<summary>Run details</summary>']) assert.ok(text.includes(marker), marker);
    assert.doesNotMatch(text, /Closes #7|## Plan\b|## Impact/);
  });

  it("numbers the points from the context when Prepare recorded them, review comments included", () => {
    const withPoints: WorkContext = { ...reworkCtx, reworkPoints: [{ author: 'alice', path: 'src/a.ts', line: 3 }, { author: 'bob' }, { author: 'carol' }, { author: 'dave', path: 'src/d.ts', line: 9 }] };
    const text = reworkComment(withPoints, rework, summary, PASS, HEAD, {});
    assert.match(text, /4\. @dave on `src\/d\.ts:9`: _Not reported by the builder\._/);
  });

  it("answers a conversation request as the requester's", () => {
    const asked = { ...rework, cause: 'comment' as const, details: [{ author: 'alice', body: 'Rename it.' }] };
    const askedCtx: WorkContext = { ...reworkCtx, workItem: { ...reworkCtx.workItem, requestedBy: 'alice', context: asked }, reworkPoints: [{ author: 'alice' }] };
    const text = reworkComment(askedCtx, asked, '## Rework points\n- 1: Renamed.\n## Summary\nok', PASS, HEAD, {});
    assert.match(text, /^Factorial has reworked this pull request after the request from @alice\./);
    assert.match(text, /## Request\n\n1\. @alice: Renamed\./);
  });

  it('heads the points as failing checks for a checks-failed rework, and copes with none recorded', () => {
    const failed = { ...rework, cause: 'checks-failed' as const, details: [] };
    const text = reworkComment({ ...reworkCtx, reworkPoints: [] }, failed, summaryMd(), PASS, HEAD, {});
    assert.match(text, /after the failing checks\./);
    assert.match(text, /## Failing checks\n\n_No specific points were recorded for this rework\._/);
  });

  it('never mentions an author that is not a valid login, and keeps answers to one capped line', () => {
    const odd = { ...rework, details: [{ author: 'x @everyone', body: 'b' }] };
    const text = reworkComment({ ...reworkCtx, reworkPoints: [{ author: 'x @everyone' }] }, odd, `## Rework points\n- 1: ${'long '.repeat(200)}\n## Summary\nok`, PASS, HEAD, {});
    assert.match(text, /1\. `x @everyone`: /);
    assert.ok(!text.split('`x @everyone`').join('').includes('@everyone'), 'the author appears only inside its code span');
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    assert.ok(line.length < 400, `line is ${line.length} characters`);
  });
});

describe('safeLogin', () => {
  it('accepts user and bot logins and rejects anything else', () => {
    assert.equal(safeLogin('Jamie-Geddes'), 'Jamie-Geddes');
    assert.equal(safeLogin('factorial-x[bot]'), 'factorial-x[bot]');
    for (const bad of ['', '-lead', 'trail-', 'two--hyphens', 'a b', '@x', 'x'.repeat(40)]) assert.equal(safeLogin(bad), undefined, bad);
  });
});

describe('noMentions', () => {
  it('stops agent text mentioning people or teams, whatever surrounds the @', () => {
    assert.equal(noMentions('ping @alice and @org/team'), 'ping @\u200balice and @\u200borg/team');
    assert.equal(noMentions('\\`@alice\\` and ``a ` @bob``'), '\\`@\u200balice\\` and ``a ` @\u200bbob``');
    assert.equal(noMentions('mail a@b.com, @ alone'), 'mail a@\u200bb.com, @ alone');
  });

  it('applies after cutting, so a cut cannot leave a mention unescaped', () => {
    const text = agentText(`${'x'.repeat(95)} @alice`, 100);
    assert.doesNotMatch(text, /@a/);
  });

  it('applies to the builder slots of the body and the rework reply', () => {
    const body = render(summaryMd().replace('Adds the thing so operators can see it.', 'Thanks @everyone and @alice.'));
    assert.doesNotMatch(body, /@everyone|@alice/);
    assert.match(body, /@\u200beveryone/);
  });
});

describe('runDetailsSection', () => {
  it('records the work branch in the Run details', () => {
    assert.match(render(summaryMd()), new RegExp(`^\\| Branch \\| \`${ctx.branch}\` \\|$`, 'm'));
  });
});
