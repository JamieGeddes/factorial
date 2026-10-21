/**
 * Check the GitHub Actions workflows and composite actions against the
 * repository's workflow conventions.
 *
 * Parses every file in .github/workflows (YAML) and every
 * .github/actions/(dir)/action.yml, and reports any violation of the five rules listed under "Workflows" in
 * CLAUDE.md, naming the file, the job (or step) and the rule for each. The
 * rules are exported as pure functions over the parsed YAML so they can be
 * tested with fixtures (see scripts/check-workflows.test.ts); file reading
 * and reporting stay in main().
 *
 * Usage: node scripts/check-workflows.ts
 *
 * Fails with exit code 1 when any rule is violated, so it can run in CI.
 * Rule 1 (the deploy role needs the production environment and the trust
 * gate) matches the gate by substring: the reference is the classify and
 * deploy jobs of .github/workflows/deploy.yml.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

export interface Job {
  name?: string;
  environment?: unknown;
  if?: string;
  steps?: Step[];
}

export interface Workflow {
  name?: string;
  jobs?: Record<string, Job>;
}

export interface ActionFile {
  runs?: { steps?: Step[] };
}

/** The if: clauses every job that assumes the deploy role must carry. */
const DEPLOY_TRUST_GATE = [
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/main'",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
] as const;

export const RULE_DEPLOY_ROLE =
  'deploy role needs the production environment and the trust gate';
export const RULE_PINNED_SHAS = 'remote actions must be pinned to a full commit SHA';
export const RULE_NO_CACHE = 'no Actions cache';
export const RULE_FULL_HISTORY = 'full history where history is diffed';
export const RULE_REQUIRED_CHECKS = 'required checks still exist';

export interface Violation {
  rule: string;
  file: string;
  job?: string;
  step?: string;
  message: string;
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? job.steps : [];
}

function jobLabel(key: string, job: Job): string {
  return typeof job.name === 'string' && job.name.length > 0 ? job.name : key;
}

function stepLabel(step: Step): string {
  return step.name ?? step.id ?? step.uses ?? step.run ?? '(unnamed step)';
}

function isDeployRoleStep(step: Step): boolean {
  return (
    typeof step.uses === 'string' &&
    step.uses.startsWith('aws-actions/configure-aws-credentials') &&
    typeof step.with?.['role-to-assume'] === 'string' &&
    (step.with['role-to-assume'] as string).includes('secrets.AWS_DEPLOY_ROLE_ARN')
  );
}

/** Rule 1: a job that assumes the deploy role declares the environment and the trust gate. */
export function deployRoleNeedsProductionEnvironmentAndTrustGate(
  workflow: Workflow,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
    if (!stepsOf(job).some(isDeployRoleStep)) continue;
    const label = jobLabel(key, job);
    if (job.environment !== 'production') {
      violations.push({
        rule: RULE_DEPLOY_ROLE,
        file,
        job: label,
        message: 'job must declare environment: production',
      });
    }
    const condition = typeof job.if === 'string' ? job.if : '';
    const missing = DEPLOY_TRUST_GATE.filter((clause) => !condition.includes(clause));
    if (missing.length > 0) {
      violations.push({
        rule: RULE_DEPLOY_ROLE,
        file,
        job: label,
        message: 'if: is missing the deploy trust gate clause(s): ' + missing.join('; '),
      });
    }
  }
  return violations;
}

function isRemoteAction(uses: string): boolean {
  return !uses.startsWith('./') && !uses.startsWith('docker://');
}

/** Rule 2: every remote uses: is pinned to a 40-character commit SHA. */
export function actionsArePinnedToFullCommitShas(
  document: Workflow | ActionFile,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  const jobEntries: [string, Job][] = Object.entries(
    (document as Workflow).jobs ?? {},
  );
  const scopes: { label: string; steps: Step[] }[] = jobEntries.length
    ? jobEntries.map(([key, job]) => ({ label: jobLabel(key, job), steps: stepsOf(job) }))
    : [{ label: '(action)', steps: (document as ActionFile).runs?.steps ?? [] }];
  for (const scope of scopes) {
    for (const step of scope.steps) {
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (!uses || !isRemoteAction(uses)) continue;
      if (!/^[^@]+@[0-9a-f]{40}$/.test(uses)) {
        violations.push({
          rule: RULE_PINNED_SHAS,
          file,
          job: scope.label === '(action)' ? undefined : scope.label,
          step: stepLabel(step),
          message: uses + ' is not pinned to a 40-character commit SHA',
        });
      }
    }
  }
  return violations;
}

/** Rule 3: no actions/cache step and no actions/setup-node step with cache:. */
export function noActionsCache(
  document: Workflow | ActionFile,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  const jobEntries: [string, Job][] = Object.entries(
    (document as Workflow).jobs ?? {},
  );
  const scopes: { label?: string; steps: Step[] }[] = jobEntries.length
    ? jobEntries.map(([key, job]) => ({ label: jobLabel(key, job), steps: stepsOf(job) }))
    : [{ steps: (document as ActionFile).runs?.steps ?? [] }];
  for (const scope of scopes) {
    for (const step of scope.steps) {
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (uses.startsWith('actions/cache')) {
        violations.push({
          rule: RULE_NO_CACHE,
          file,
          job: scope.label,
          step: stepLabel(step),
          message: 'step uses ' + uses + '; the Actions cache is not used in this repository',
        });
      }
      if (
        uses.startsWith('actions/setup-node') &&
        step.with && 'cache' in step.with
      ) {
        violations.push({
          rule: RULE_NO_CACHE,
          file,
          job: scope.label,
          step: stepLabel(step),
          message: 'actions/setup-node step sets cache:; the Actions cache is not used in this repository',
        });
      }
    }
  }
  return violations;
}

const HISTORY_COMMANDS = ['git diff', 'git log', 'git merge-base'] as const;

function jobDiffsHistory(job: Job): boolean {
  return stepsOf(job).some(
    (step) =>
      (typeof step.uses === 'string' &&
        step.uses.startsWith('./.github/actions/classify-changes')) ||
      (typeof step.run === 'string' &&
        HISTORY_COMMANDS.some((command) => step.run!.includes(command))),
  );
}

/** Rule 4: a job that diffs history checks out with fetch-depth: 0. */
export function fullHistoryWhereHistoryIsDiffed(
  workflow: Workflow,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
    if (!jobDiffsHistory(job)) continue;
    const full = stepsOf(job).some(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/checkout') &&
        step.with?.['fetch-depth'] === 0,
    );
    if (!full) {
      violations.push({
        rule: RULE_FULL_HISTORY,
        file,
        job: jobLabel(key, job),
        message:
          'job diffs history (uses ./.github/actions/classify-changes or runs git diff/log/merge-base) ' +
          'but its actions/checkout step does not set fetch-depth: 0',
      });
    }
  }
  return violations;
}

const REQUIRED_CHECKS = ['Typecheck, test and lint', 'Lint CloudFormation'] as const;

/** Rule 5: ci.yml still defines the checks the main ruleset requires by name. */
export function requiredChecksExist(workflow: Workflow, file: string): Violation[] {
  const names = Object.values(workflow.jobs ?? {})
    .map((job) => (typeof job.name === 'string' ? job.name : ''))
    .filter((name) => name.length > 0);
  return REQUIRED_CHECKS.filter((required) => !names.includes(required)).map(
    (required) => ({
      rule: RULE_REQUIRED_CHECKS,
      file,
      message: 'no job named ' + required + ', which the main ruleset requires',
    }),
  );
}

function findWorkflowFiles(): string[] {
  const directory = '.github/workflows';
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((name) => directory + '/' + name);
}

function findActionFiles(): string[] {
  const directory = '.github/actions';
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => directory + '/' + entry.name + '/action.yml')
    .filter((path) => existsSync(path))
    .sort();
}

function main(): void {
  const files = [...findWorkflowFiles(), ...findActionFiles()];
  const violations: Violation[] = [];
  for (const file of files) {
    let document: unknown;
    try {
      document = parse(readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(file + ': could not parse YAML: ' + String(error));
      process.exitCode = 1;
      continue;
    }
    const workflow = (document ?? {}) as Workflow;
    violations.push(
      ...deployRoleNeedsProductionEnvironmentAndTrustGate(workflow, file),
      ...actionsArePinnedToFullCommitShas(workflow, file),
      ...noActionsCache(workflow, file),
    );
    if (file.startsWith('.github/workflows/')) {
      violations.push(
        ...fullHistoryWhereHistoryIsDiffed(workflow, file),
        ...(file === '.github/workflows/ci.yml'
          ? requiredChecksExist(workflow, file)
          : []),
      );
    }
  }
  for (const violation of violations) {
    const job = violation.job ? ': job ' + violation.job + ': ' : ': ';
    const step = violation.step ? ' (step ' + violation.step + ')' : '';
    console.error(violation.file + job + violation.rule + step + ' - ' + violation.message);
  }
  if (violations.length > 0) {
    console.error('check-workflows: ' + violations.length + ' violation(s) in ' + files.length + ' file(s).');
    process.exitCode = 1;
    return;
  }
  console.log('check-workflows: ' + files.length + ' file(s) checked, no violations.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
