import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_FILE_BYTES,
  MAX_LOG_TOTAL_BYTES,
  batches,
  dropPartialFirstLine,
  fetchScript,
  parseFetch,
  parseListing,
  planExport,
  type SessionFile,
} from './session-files.ts';

const MB = 1024 * 1024;
const log = (name: string, bytes: number): SessionFile => ({ kind: 'log', name, bytes });

describe('parseListing', () => {
  it('keeps the known top-level files and safely named logs', () => {
    const { files, rejected } = parseListing('top\tsummary.md\t120\ntop\tnotes.md\t900\nlog\t001-npm-test.log\t4000\n');
    assert.deepEqual(files, [
      { kind: 'top', name: 'summary.md', bytes: 120 },
      { kind: 'top', name: 'notes.md', bytes: 900 },
      { kind: 'log', name: '001-npm-test.log', bytes: 4000 },
    ]);
    assert.equal(rejected, 0);
  });

  it('drops names the agent could use against a shell or a key, and malformed lines', () => {
    const listing = [
      "log\t$(rm -rf /).log\t1",
      'log\t..\t1',
      'log\t.hidden\t1',
      'log\ta b.log\t1',
      'top\t/etc/passwd\t1',
      'log\tok.log\tnot-a-number',
      'log\tok.log\t1\textra',
      'log\tgood.log\t5',
    ].join('\n');
    const { files, rejected } = parseListing(listing);
    assert.deepEqual(files, [{ kind: 'log', name: 'good.log', bytes: 5 }]);
    assert.equal(rejected, 7);
  });
});

describe('planExport', () => {
  it('stores top-level files under build/ and logs under build/logs/', () => {
    const plan = planExport([{ kind: 'top', name: 'summary.md', bytes: 10 }, log('001-a.log', 20)]);
    assert.deepEqual(
      plan.fetch.map((f) => f.path),
      ['build/summary.md', 'build/logs/001-a.log'],
    );
    assert.deepEqual(plan.skipped, []);
  });

  it('keeps only the last 5 MB of a larger file', () => {
    const [file] = planExport([log('001-huge.log', 12 * MB)]).fetch;
    assert.equal(file?.readBytes, MAX_FILE_BYTES);
    assert.equal(file?.truncated, true);
  });

  it('takes logs in name order up to the 50 MB total and lists the rest as skipped', () => {
    const logs = Array.from({ length: 12 }, (_, i) => log(`${String(12 - i).padStart(3, '0')}-x.log`, 5 * MB));
    const plan = planExport(logs);
    assert.equal(plan.fetch.length, MAX_LOG_TOTAL_BYTES / (5 * MB));
    assert.equal(plan.fetch[0]?.name, '001-x.log');
    assert.deepEqual(
      plan.skipped.map((s) => s.name),
      ['011-x.log', '012-x.log'],
    );
    assert.match(plan.skipped[0]?.reason ?? '', /total/);
  });

  it('does not count top-level files against the log total', () => {
    const logs = Array.from({ length: 10 }, (_, i) => log(`${i}.log`, 5 * MB));
    const plan = planExport([{ kind: 'top', name: 'notes.md', bytes: 5 * MB }, ...logs]);
    assert.equal(plan.fetch.length, 11);
    assert.equal(plan.skipped.length, 0);
  });
});

describe('fetching', () => {
  it('batches files to keep each command output bounded', () => {
    const plan = planExport([log('1.log', 5 * MB), log('2.log', 2 * MB), log('3.log', 3 * MB)]);
    assert.deepEqual(
      batches(plan.fetch).map((group) => group.map((f) => f.name)),
      [['1.log', '2.log'], ['3.log']],
    );
  });

  it('reads only regular files, capped by the read itself', () => {
    const [file] = planExport([log('001-npm-test.log', 12 * MB)]).fetch;
    const script = fetchScript(file ? [file] : []);
    assert.match(script, /\[ -f '\/workspace\/logs\/001-npm-test\.log' \] && \[ ! -L '\/workspace\/logs\/001-npm-test\.log' \]/);
    assert.match(script, new RegExp(`tail -c ${MAX_FILE_BYTES} -- '/workspace/logs/001-npm-test.log'`));
  });

  it('decodes each section, and marks files that disappeared', () => {
    const plan = planExport([log('a.log', 5), log('b.log', 5)]).fetch;
    const script = fetchScript(plan);
    const separator = /printf '%s' '([^']*)'/.exec(script)?.[1] ?? '';
    const stdout = `ok:${Buffer.from('hello').toString('base64')}${separator}missing:`;
    const [a, b] = parseFetch(stdout, 2);
    assert.equal(a?.toString('utf8'), 'hello');
    assert.equal(b, undefined);
  });

  it('drops the partial first line of a file read from its end', () => {
    const token = `ghs_${'C'.repeat(36)}`;
    const tail = Buffer.from(`${token.slice(10)} leaked\nnext line\n`);
    assert.equal(dropPartialFirstLine(tail).toString(), 'next line\n');
    assert.equal(dropPartialFirstLine(Buffer.from('no newline at all')).length, 0);
  });

  it('refuses output that is not what the script prints', () => {
    assert.throws(() => parseFetch('ok:not base64!', 1));
    assert.throws(() => parseFetch('ok:aGVsbG8=', 2));
  });
});
