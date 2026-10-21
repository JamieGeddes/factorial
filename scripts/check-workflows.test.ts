import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import {
  actionsArePinnedToFullCommitShas,
  deployRoleNeedsProductionEnvironmentAndTrustGate,
  fullHistoryWhereHistoryIsDiffed,
  noActionsCache,
  requiredChecksExist,
  RULE_DEPLOY_ROLE,
  RULE_FULL_HISTORY,
  RULE_NO_CACHE,
  RULE_PINNED_SHAS,
  RULE_REQUIRED_CHECKS,
  type Workflow,
} from './check-workflows.ts';

function workflowOf(yaml: string): Workflow {
  return parse(yaml) as Workflow;
}

const SHA = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';

const FULL_GATE = [
  "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||",
  "(github.event_name == 'workflow_run' &&",
  " github.event.workflow_run.conclusion == 'success' &&",
  " github.event.workflow_run.event == 'push' &&",
  " github.event.workflow_run.head_branch == 'main' &&",
  ' github.event.workflow_run.head_repository.full_name == github.repository)',
].map((line) => '      ' + line).join('\n');

describe('deployRoleNeedsProductionEnvironmentAndTrustGate', () => {
  const job = (extra: string) => `
jobs:
  deploy:
    ${extra}
    steps:
      - uses: aws-actions/configure-aws-credentials@4a1596c86fd706dc0521e32f0121ad1a6d1adb74
        with:
          role-to-assume: \${{ secrets.AWS_DEPLOY_ROLE_ARN }}
`;

  it('accepts a deploy-role job with the production environment and the full gate', () => {
    const violations = deployRoleNeedsProductionEnvironmentAndTrustGate(
      workflowOf(job(`environment: production\n    if: >-\n${FULL_GATE}`)),
      'deploy.yml',
    );
    assert.deepEqual(violations, []);
  });

  it('rejects a deploy-role job without the production environment', () => {
    const violations = deployRoleNeedsProductionEnvironmentAndTrustGate(
      workflowOf(job(`if: >-\n${FULL_GATE}`)),
      'deploy.yml',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.rule, RULE_DEPLOY_ROLE);
    assert.equal(violations[0]!.file, 'deploy.yml');
    assert.match(violations[0]!!.message, /environment: production/);
  });

  it('rejects a deploy-role job with the environment but a missing trust condition', () => {
    const withoutRepository = FULL_GATE.split('\n').filter((line) => !line.includes('head_repository')).join('\n');
    const violations = deployRoleNeedsProductionEnvironmentAndTrustGate(
      workflowOf(job(`environment: production\n    if: >-\n${withoutRepository}`)),
      'deploy.yml',
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]!!.message, /head_repository\.full_name/);
  });

  it('does not cover jobs assuming other roles', () => {
    const yaml = `
jobs:
  report:
    steps:
      - uses: aws-actions/configure-aws-credentials@4a1596c86fd706dc0521e32f0121ad1a6d1adb74
        with:
          role-to-assume: \${{ secrets.AWS_TEST_CALLBACK_ROLE_ARN }}
`;
    assert.deepEqual(
      deployRoleNeedsProductionEnvironmentAndTrustGate(workflowOf(yaml), 'test.yml'),
      [],
    );
  });
});

describe('actionsArePinnedToFullCommitShas', () => {
  it('accepts a 40-hex-pinned remote action', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: actions/checkout@${SHA}
`;
    assert.deepEqual(
      actionsArePinnedToFullCommitShas(workflowOf(yaml), 'ci.yml'),
      [],
    );
  });

  it('rejects a tag-pinned remote action', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: actions/checkout@v5
`;
    const violations = actionsArePinnedToFullCommitShas(workflowOf(yaml), 'ci.yml');
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.rule, RULE_PINNED_SHAS);
    assert.match(violations[0]!!.message, /actions\/checkout@v5/);
  });

  it('exempts local actions', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: ./.github/actions/classify-changes
`;
    assert.deepEqual(
      actionsArePinnedToFullCommitShas(workflowOf(yaml), 'ci.yml'),
      [],
    );
  });
});

describe('noActionsCache', () => {
  it('rejects a setup-node step with cache:', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          cache: npm
`;
    const violations = noActionsCache(workflowOf(yaml), 'ci.yml');
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.rule, RULE_NO_CACHE);
  });

  it('rejects an actions/cache step', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: actions/cache@${SHA}
`;
    assert.equal(noActionsCache(workflowOf(yaml), 'ci.yml').length, 1);
  });

  it('accepts steps without the Actions cache', () => {
    const yaml = `
jobs:
  checks:
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          node-version-file: .nvmrc
`;
    assert.deepEqual(noActionsCache(workflowOf(yaml), 'ci.yml'), []);
  });
});

describe('fullHistoryWhereHistoryIsDiffed', () => {
  const classifyJob = (checkout: string) => `
jobs:
  classify:
    steps:
${checkout}
      - uses: ./.github/actions/classify-changes
`;

  it('rejects a classify step after a shallow checkout', () => {
    const violations = fullHistoryWhereHistoryIsDiffed(
      workflowOf(classifyJob('      - uses: actions/checkout@' + SHA)),
      'ci.yml',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.rule, RULE_FULL_HISTORY);
    assert.match(violations[0]!!.message, /fetch-depth: 0/);
  });

  it('accepts the same job with fetch-depth: 0', () => {
    const violations = fullHistoryWhereHistoryIsDiffed(
      workflowOf(
        classifyJob(`      - uses: actions/checkout@${SHA}
        with:
          fetch-depth: 0`),
      ),
      'ci.yml',
    );
    assert.deepEqual(violations, []);
  });

  it('flags a run step that diffs a commit range', () => {
    const yaml = `
jobs:
  compare:
    steps:
      - run: git diff --name-only main...head
`;
    assert.equal(fullHistoryWhereHistoryIsDiffed(workflowOf(yaml), 'x.yml').length, 1);
  });
});

describe('requiredChecksExist', () => {
  it('accepts ci.yml with both required check names', () => {
    const yaml = `
jobs:
  checks:
    name: Typecheck, test and lint
  templates:
    name: Lint CloudFormation
`;
    assert.deepEqual(requiredChecksExist(workflowOf(yaml), 'ci.yml'), []);
  });

  it('rejects ci.yml missing a required check name', () => {
    const yaml = `
jobs:
  checks:
    name: Typecheck, test and lint
`;
    const violations = requiredChecksExist(workflowOf(yaml), 'ci.yml');
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.rule, RULE_REQUIRED_CHECKS);
    assert.match(violations[0]!!.message, /Lint CloudFormation/);
  });
});

describe('reporting', () => {
  it('names the file, the job and the rule', () => {
    const yaml = `
jobs:
  deploy:
    steps:
      - uses: aws-actions/configure-aws-credentials@4a1596c86fd706dc0521e32f0121ad1a6d1adb74
        with:
          role-to-assume: \${{ secrets.AWS_DEPLOY_ROLE_ARN }}
`;
    const violations = deployRoleNeedsProductionEnvironmentAndTrustGate(
      workflowOf(yaml),
      '.github/workflows/deploy.yml',
    );
    assert.equal(violations[0]!.file, '.github/workflows/deploy.yml');
    assert.equal(violations[0]!.job, 'deploy');
    assert.equal(violations[0]!.rule, RULE_DEPLOY_ROLE);
  });
});
