/**
 * Checks on the transfer bucket (#262): ephemeral, private, TLS only, and
 * read and written only by the three stages that seed sessions from a
 * repository bundle, which run from the orchestration image with room for it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resource, resources, type Json } from './template-checks.ts';

const SEEDING = ['PrepareFunction', 'ContinueBuildFunction', 'PrepareReviewFunction'];

test('the transfer bucket is private, unversioned, encrypted and expires every object after a day', () => {
  const properties = resource('TransferBucket').Properties as Json;
  assert.deepEqual(properties.BucketName, { 'Fn::Sub': 'factorial-transfer-${AWS::AccountId}' });
  assert.equal(properties.VersioningConfiguration, undefined);
  assert.deepEqual(properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.equal(JSON.stringify(properties.BucketEncryption).includes('"SSEAlgorithm":"AES256"'), true);
  const rules = (properties.LifecycleConfiguration as { Rules: Json[] }).Rules;
  assert.deepEqual(rules, [{ Id: 'ExpireTransfers', Status: 'Enabled', ExpirationInDays: 1, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }]);
});

test('the transfer bucket denies plain HTTP, and reads by any principal but the seeding stages', () => {
  const statements = ((resource('TransferBucketPolicy').Properties as Json).PolicyDocument as { Statement: Json[] }).Statement;
  const tls = statements.find((s) => s.Sid === 'RequireTls');
  assert.deepEqual(tls?.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  assert.equal(tls?.Effect, 'Deny');
  const reads = statements.find((s) => s.Sid === 'DenyReadsByOthers');
  assert.equal(reads?.Effect, 'Deny');
  assert.equal(reads?.Action, 's3:GetObject');
  const allowed = ((reads?.Condition as Json).ArnNotEquals as Json)['aws:PrincipalArn'];
  assert.deepEqual(allowed, SEEDING.map((fn) => ({ 'Fn::GetAtt': `${fn}Role.Arn` })));
});

test('only the seeding stages are granted the transfer bucket, and the artefact store grants it to nobody else', () => {
  const policy = resource('TransferSeedPolicy').Properties as Json;
  const statement = (policy.PolicyDocument as { Statement: Json[] }).Statement;
  assert.deepEqual(statement, [
    { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], Resource: { 'Fn::Sub': '${TransferBucket.Arn}/*' } },
  ]);
  const holders = Object.entries(resources())
    .filter(([, d]) => JSON.stringify(d.Properties ?? {}).includes('"Ref":"TransferSeedPolicy"'))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(holders, [...SEEDING].sort());
  const mentions = Object.entries(resources())
    .filter(([name, d]) => !name.startsWith('Transfer') && JSON.stringify(d).includes('TransferBucket.Arn'))
    .map(([name]) => name);
  assert.deepEqual(mentions, []);
});

test('the seeding stages run from the orchestration image with 2 GB of memory and of /tmp, and know the bucket', () => {
  for (const fn of SEEDING) {
    const properties = resource(fn).Properties as Json;
    assert.equal(properties.PackageType, 'Image', fn);
    assert.equal(properties.MemorySize, 2048, fn);
    assert.deepEqual(properties.EphemeralStorage, { Size: 2048 }, fn);
    assert.deepEqual((properties.Environment as { Variables: Json }).Variables.TRANSFER_BUCKET, { Ref: 'TransferBucket' }, fn);
  }
});
