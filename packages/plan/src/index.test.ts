import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLAN_SCHEMA_VERSION, PlanValidationError, assertPlan, parsePlanJson, validatePlan, type Plan } from './index.ts';

const examplesDir = fileURLToPath(new URL('../../../contracts/plan/v1/examples/', import.meta.url));

async function loadExample(name: string): Promise<Plan> {
  return JSON.parse(await readFile(path.join(examplesDir, name), 'utf8')) as Plan;
}

describe('Plan schema', () => {
  it('accepts every example in the contract directory', async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0, 'expected at least one example');
    for (const file of files) {
      const result = validatePlan(await loadExample(file));
      assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    }
  });

  it('returns a typed value on success', async () => {
    const result = validatePlan(await loadExample('single-change.json'));
    assert.ok(result.ok);
    assert.equal(result.value.schemaVersion, PLAN_SCHEMA_VERSION);
    assert.equal(result.value.steps[0]?.id, 'validate-quantity');
  });

  it('rejects a missing required field and an unknown one', async () => {
    const missing = structuredClone(await loadExample('single-change.json')) as Partial<Plan>;
    delete missing.risks;
    const result = validatePlan(missing);
    assert.ok(!result.ok && result.errors.some((e) => e.includes('risks')));

    const extra = { ...(await loadExample('single-change.json')), children: [] };
    const extraResult = validatePlan(extra);
    assert.ok(!extraResult.ok && extraResult.errors.some((e) => e.includes('"children"')));
  });

  it('rejects unknown properties inside a step and in tests', async () => {
    const plan = structuredClone(await loadExample('single-change.json')) as unknown as {
      steps: Array<Record<string, unknown>>;
      tests: Record<string, unknown>;
    };
    plan.steps[0]!.owner = 'builder';
    plan.tests.skip = [];
    const result = validatePlan(plan);
    assert.ok(!result.ok && result.errors.length === 2);
  });

  it('rejects an empty plan and more than 30 steps', async () => {
    const plan = await loadExample('documentation-only.json');
    assert.equal(validatePlan({ ...plan, steps: [] }).ok, false);
    const step = plan.steps[0]!;
    const many = Array.from({ length: 31 }, (_, i) => ({ ...step, id: `step-${i}` }));
    assert.equal(validatePlan({ ...plan, steps: many }).ok, false);
  });

  it('accepts a plan with or without followUp, and rejects more than 20 items', async () => {
    const plan = await loadExample('single-change.json');
    assert.equal(plan.followUp?.length, 1);
    const { followUp: _followUp, ...without } = plan;
    assert.equal(validatePlan(without).ok, true);
    assert.equal(validatePlan({ ...plan, followUp: Array.from({ length: 21 }, () => 'Later.') }).ok, false);
    assert.equal(validatePlan({ ...plan, followUp: [''] }).ok, false);
  });

  it('rejects duplicate step ids', async () => {
    const plan = await loadExample('single-change.json');
    const result = validatePlan({ ...plan, steps: [plan.steps[0]!, { ...plan.steps[1]!, id: plan.steps[0]!.id }] });
    assert.ok(!result.ok && result.errors.some((e) => e.startsWith('/steps/1/id')));
  });

  it('rejects malformed step ids', async () => {
    const plan = await loadExample('documentation-only.json');
    for (const id of ['', 'Fix Typo', '-lead', 'x'.repeat(41)]) {
      assert.equal(validatePlan({ ...plan, steps: [{ ...plan.steps[0]!, id }] }).ok, false, id);
    }
  });

  it('rejects absolute paths and paths that leave the repository', async () => {
    const plan = await loadExample('documentation-only.json');
    for (const file of ['/etc/passwd', '../outside.ts', 'src/../../outside.ts', 'src/..']) {
      assert.equal(validatePlan({ ...plan, steps: [{ ...plan.steps[0]!, files: [file] }] }).ok, false, file);
    }
    for (const file of ['src/a..b.ts', '.github/workflows/ci.yml']) {
      assert.equal(validatePlan({ ...plan, steps: [{ ...plan.steps[0]!, files: [file] }] }).ok, true, file);
    }
  });

  it('rejects a schemaVersion other than 1', async () => {
    assert.equal(validatePlan({ ...(await loadExample('single-change.json')), schemaVersion: 2 }).ok, false);
  });

  it('assertPlan throws a PlanValidationError listing every problem', () => {
    assert.throws(
      () => assertPlan({ schemaVersion: 1 }),
      (error: unknown) => error instanceof PlanValidationError && error.errors.length >= 5,
    );
  });

  it('parsePlanJson reports a syntax error as a validation error', () => {
    const result = parsePlanJson('{"schemaVersion": 1,');
    assert.ok(!result.ok && result.errors[0]?.startsWith('(root) is not valid JSON'));
  });

  it('parsePlanJson accepts valid text', async () => {
    const text = await readFile(path.join(examplesDir, 'single-change.json'), 'utf8');
    assert.equal(parsePlanJson(text).ok, true);
  });
});
