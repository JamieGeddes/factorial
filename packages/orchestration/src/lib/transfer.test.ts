import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRESIGNED_URL_SECONDS, transferKey } from './transfer.ts';

const PREFIX = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/2/';

describe('transferKey', () => {
  it('follows the correlation convention: <workItemId>/<attempt>/<stage>/<file>', () => {
    assert.equal(transferKey(PREFIX, 'prepare', 'repo.bundle'), `${PREFIX}prepare/repo.bundle`);
    assert.equal(transferKey(PREFIX, 'build/round-2', 'repo.bundle'), `${PREFIX}build/round-2/repo.bundle`);
  });

  it('rejects a prefix, stage or file that is not plain', () => {
    assert.throws(() => transferKey('x/1/', 'prepare', 'repo.bundle'), /artefact prefix/);
    assert.throws(() => transferKey(PREFIX, '../other', 'repo.bundle'), /transfer stage/);
    assert.throws(() => transferKey(PREFIX, 'prepare', '../repo.bundle'), /transfer file/);
  });
});

describe('presigned URLs', () => {
  it('expire after five minutes', () => {
    assert.equal(PRESIGNED_URL_SECONDS, 300);
  });
});
