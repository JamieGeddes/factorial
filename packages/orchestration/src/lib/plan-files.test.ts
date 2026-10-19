import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  MAX_PLAN_FILE_BYTES,
  checkPlanFiles,
  parsePlanRead,
  planDigest,
  readPlanScript,
  rejectionNotesScript,
  seedPlanScript,
} from './plan-files.ts';

const SECTION = '\n===FACTORIAL-PLAN===\n';
const validJson = await readFile(new URL('../../../../contracts/plan/v1/examples/single-change.json', import.meta.url), 'utf8');
const md = '# Plan\n\nReject bad quantities.\n';
const file = (text: string, size = Buffer.byteLength(text)) => ({ text, size });
const encoded = (text: string) => `ok:${Buffer.byteLength(text)}:${Buffer.from(text).toString('base64')}`;

describe('readPlanScript', () => {
  it('reads only regular files, never symlinks, and caps the read one byte over the limit', () => {
    const script = readPlanScript();
    assert.match(script, /\[ -f '\/workspace\/plan\.md' \] && \[ ! -L '\/workspace\/plan\.md' \]/);
    assert.match(script, /\[ -f '\/workspace\/plan\.json' \] && \[ ! -L '\/workspace\/plan\.json' \]/);
    assert.match(script, new RegExp(`head -c ${MAX_PLAN_FILE_BYTES + 1} -- '/workspace/plan.json'`));
  });
});

describe('parsePlanRead', () => {
  it('decodes both files with their sizes', () => {
    const files = parsePlanRead(`${encoded(md)}${SECTION}${encoded(validJson)}`);
    assert.equal(files.markdown?.text, md);
    assert.equal(files.json?.size, Buffer.byteLength(validJson));
  });

  it('reports a missing file as undefined', () => {
    const files = parsePlanRead(`missing:${SECTION}${encoded(validJson)}`);
    assert.equal(files.markdown, undefined);
    assert.ok(files.json);
  });

  it('rejects output that is not what the script prints', () => {
    assert.throws(() => parsePlanRead('ok:1:abc'), /expected 2 plan files/);
    assert.throws(() => parsePlanRead(`ok:x:${SECTION}missing:`), /did not produce base64/);
  });
});

describe('checkPlanFiles', () => {
  it('accepts a valid plan and returns the text it validated', () => {
    const checked = checkPlanFiles({ markdown: file(md), json: file(validJson) });
    assert.ok(checked.ok);
    assert.equal(checked.json, validJson);
    assert.equal(checked.plan.steps.length, 2);
  });

  it('names every missing file', () => {
    const checked = checkPlanFiles({});
    assert.ok(!checked.ok);
    assert.deepEqual(checked.errors, ['/workspace/plan.md is missing', '/workspace/plan.json is missing']);
  });

  it('rejects files over the limit by their real size', () => {
    const checked = checkPlanFiles({ markdown: file(md), json: file(validJson, MAX_PLAN_FILE_BYTES + 1) });
    assert.ok(!checked.ok && checked.errors[0]?.includes('over the 65536-byte limit'));
  });

  it('rejects an empty plan.md', () => {
    const checked = checkPlanFiles({ markdown: file('  \n'), json: file(validJson) });
    assert.ok(!checked.ok && checked.errors[0] === '/workspace/plan.md is empty');
  });

  it('reports invalid JSON and schema errors, prefixed with the file', () => {
    const syntax = checkPlanFiles({ markdown: file(md), json: file('{"schemaVersion": 1,') });
    assert.ok(!syntax.ok && syntax.errors[0]?.startsWith('plan.json (root) is not valid JSON'));
    const schema = checkPlanFiles({ markdown: file(md), json: file(JSON.stringify({ ...JSON.parse(validJson), steps: [] })) });
    assert.ok(!schema.ok && schema.errors.some((e) => e.startsWith('plan.json /steps')));
  });

  it('keeps at most ten errors, each cut short', () => {
    const plan = JSON.parse(validJson);
    const json = JSON.stringify({ ...plan, steps: Array.from({ length: 12 }, () => ({ id: 'Bad Id', description: '', files: [], verification: '' })) });
    const checked = checkPlanFiles({ markdown: file(md), json: file(json) });
    assert.ok(!checked.ok);
    assert.equal(checked.errors.length, 10);
    assert.ok(checked.errors.every((e) => e.length <= 301));
  });

  it('redacts both files before validating and returning them', () => {
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const plan = JSON.parse(validJson);
    const json = JSON.stringify({ ...plan, risks: [`token ${token} was printed`] });
    const checked = checkPlanFiles({ markdown: file(`${md}\n${token}\n`), json: file(json) });
    assert.ok(checked.ok);
    assert.ok(!checked.json.includes(token) && !checked.markdown.includes(token));
  });
});

describe('session scripts', () => {
  it('appends the rejection to the planner notes', () => {
    const script = rejectionNotesScript(1, ['/workspace/plan.json is missing']);
    const encodedSection = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d >> \/workspace\/notes\.md/.exec(script)?.[1] ?? '';
    const section = Buffer.from(encodedSection, 'base64').toString('utf8');
    assert.match(section, /# Plan rejected \(attempt 1\)/);
    assert.match(section, /- \/workspace\/plan\.json is missing/);
  });

  it('writes both plan files into the builder session', () => {
    const script = seedPlanScript(md, validJson);
    assert.match(script, /base64 -d > \/workspace\/plan\.md/);
    assert.match(script, /base64 -d > \/workspace\/plan\.json/);
  });
});

describe('planDigest', () => {
  it('keeps the summary and the first line of each step, cut to 200 characters', () => {
    const plan = JSON.parse(validJson);
    plan.steps[0].description = `${'x'.repeat(250)}\nsecond line`;
    const digest = planDigest(plan);
    assert.equal(digest.summary, plan.summary);
    assert.equal(digest.steps[0]?.description.length, 201);
    assert.equal(digest.steps[1]?.id, 'handler-tests');
  });
});
