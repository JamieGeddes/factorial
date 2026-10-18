import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { artefactKey, artefactObject, artefactPrefix, testResultArtefact } from './artefacts.ts';

const id = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';

describe('artefact keys', () => {
  it('puts every object under <workItemId>/<attempt>/', () => {
    const prefix = artefactPrefix(id, 1);
    assert.equal(prefix, `${id}/1/`);
    assert.equal(artefactKey(prefix, 'workitem.json'), `${id}/1/workitem.json`);
    assert.equal(artefactKey(artefactPrefix(id, 2), 'prepare/branch.json'), `${id}/2/prepare/branch.json`);
  });

  it('rejects attempts that are not positive integers', () => {
    assert.throws(() => artefactPrefix(id, 0));
    assert.throws(() => artefactPrefix(id, 1.5));
  });

  it('rejects ids that are not UUIDs', () => {
    assert.throws(() => artefactPrefix('../etc', 1));
    assert.throws(() => artefactKey('not-a-prefix/1/', 'report.json'));
  });

  it('rejects paths that escape or are not plain', () => {
    const prefix = artefactPrefix(id, 1);
    for (const path of ['', '/report.json', '../x.json', 'a/../b.json', 'a//b.json', 'build/', 'a b.json']) {
      assert.throws(() => artefactKey(prefix, path), path);
    }
  });
});

describe('artefactObject', () => {
  it('redacts credentials before upload', () => {
    const body = JSON.stringify({ log: 'fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git' });
    const object = artefactObject('bucket', artefactPrefix(id, 1), 'report.json', body, 'application/json');
    assert.equal(object.Key, `${id}/1/report.json`);
    assert.equal(object.ContentType, 'application/json');
    assert.doesNotMatch(String(object.Body), /abcdefghijklmnop/);
    assert.match(String(object.Body), /x-access-token:\*\*\*@/);
    assert.doesNotThrow(() => JSON.parse(String(object.Body)));
  });
});

describe('testResultArtefact', () => {
  it('takes the run id from the run URL', () => {
    assert.deepEqual(
      testResultArtefact({
        sha: 'f'.repeat(40),
        runUrl: 'https://github.com/o/r/actions/runs/123456',
        outcome: 'success',
        workItemId: id,
      } as never),
      { sha: 'f'.repeat(40), runId: 123456, runUrl: 'https://github.com/o/r/actions/runs/123456', conclusion: 'success' },
    );
  });

  it('leaves out what the callback did not carry', () => {
    assert.deepEqual(testResultArtefact({ outcome: 'failure' }), { conclusion: 'failure' });
  });
});
