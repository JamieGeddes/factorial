import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  NO_LICENCE,
  contractChanges,
  dependencyChanges,
  deployImpact,
  depsScript,
  parseDeploySettings,
  parseDeps,
  prFactsDigest,
  testFileChanges,
  type PrFacts,
} from './pr-facts.ts';

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}): string => JSON.stringify({ dependencies: deps, devDependencies: dev });
const lock = JSON.stringify({ packages: { 'node_modules/left-pad': { license: 'MIT' }, 'node_modules/nolic': {} } });

describe('dependencyChanges', () => {
  it('lists added and removed packages with the lockfile licence', () => {
    const changes = dependencyChanges(
      [{ path: 'packages/a/package.json', base: pkg({ old: '^1.0.0' }, { keep: '1' }), head: pkg({ 'left-pad': '^1.3.0' }, { keep: '1', nolic: '2' }) }],
      lock,
    );
    assert.deepEqual(changes, [
      { name: 'left-pad', change: 'added', version: '^1.3.0', dev: false, file: 'packages/a/package.json', licence: 'MIT' },
      { name: 'nolic', change: 'added', version: '2', dev: true, file: 'packages/a/package.json', licence: NO_LICENCE },
      { name: 'old', change: 'removed', version: '^1.0.0', dev: false, file: 'packages/a/package.json' },
    ]);
  });

  it('treats a new package.json as all added, and tolerates malformed input', () => {
    assert.equal(dependencyChanges([{ path: 'package.json', head: pkg({ x: '1' }) }], 'not json')[0]?.licence, NO_LICENCE);
    assert.deepEqual(dependencyChanges([{ path: 'package.json', base: '{', head: '[' }], undefined), []);
  });

  it('is empty when nothing is added or removed', () => {
    assert.deepEqual(dependencyChanges([{ path: 'package.json', base: pkg({ a: '1' }), head: pkg({ a: '2' }) }], lock), []);
  });
});

describe('parseDeploySettings', () => {
  it('reads valid settings', () => {
    const { settings, problems } = parseDeploySettings(JSON.stringify({ schemaVersion: 1, deploy: { paths: [{ prefix: 'infra/', note: 'Infra stacks' }], humanSteps: [{ prefix: 'infra/00-', note: 'Deploy the base stack' }] } }));
    assert.deepEqual(problems, []);
    assert.equal(settings?.paths[0]?.prefix, 'infra/');
    assert.equal(settings?.humanSteps[0]?.note, 'Deploy the base stack');
  });

  it('ignores missing, oversized, malformed and wrong-version files', () => {
    assert.deepEqual(parseDeploySettings(undefined), { problems: [] });
    assert.equal(parseDeploySettings('{').settings, undefined);
    assert.equal(parseDeploySettings('{"schemaVersion":2}').settings, undefined);
    assert.equal(parseDeploySettings(`{"schemaVersion":1,"pad":"${'x'.repeat(70000)}"}`).settings, undefined);
    const bad = parseDeploySettings('{"schemaVersion":1,"deploy":{"paths":[{"prefix":""}]}}');
    assert.equal(bad.settings?.paths.length, 0);
    assert.equal(bad.problems.length, 1);
  });
});

describe('deployImpact', () => {
  const settings = { paths: [{ prefix: 'infra/', note: 'Infra stacks change' }], humanSteps: [{ prefix: 'infra/00-', note: 'Deploy the base stack by hand' }] };

  it('matches changed paths against the settings only', () => {
    const impact = deployImpact(settings, ['infra/00-base.yml', 'infra/10-app.yml', 'src/x.ts']);
    assert.equal(impact.configured, true);
    assert.deepEqual(impact.notes, ['Infra stacks change: `infra/00-base.yml`, `infra/10-app.yml`']);
    assert.deepEqual(impact.humanSteps, ['Deploy the base stack by hand: `infra/00-base.yml`']);
  });

  it('assumes nothing without settings', () => {
    assert.deepEqual(deployImpact(undefined, ['templates/foundation.yml']), { configured: false, notes: [], humanSteps: [] });
  });
});

describe('contractChanges', () => {
  it('picks paths under contracts/', () => {
    assert.deepEqual(contractChanges(['contracts/a.json', 'src/contracts/b.json', 'x']), ['contracts/a.json']);
  });
});

describe('prFactsDigest', () => {
  it('keeps small facts and cuts big ones to the cap, marking them', () => {
    const small: PrFacts = { sensitive: [], contracts: [], testFiles: [], dependencies: [], deploy: { configured: false, notes: [], humanSteps: [] } };
    assert.deepEqual(prFactsDigest(small), small);
    const big: PrFacts = { ...small, contracts: Array.from({ length: 20 }, (_, i) => `contracts/${'x'.repeat(400)}${i}.json`) };
    const digest = prFactsDigest(big);
    assert.ok(JSON.stringify(digest).length <= 6100);
    assert.equal(digest.truncated, true);
  });
});

describe('depsScript', () => {
  it('prints a listing parseDeps reads, from a real repository', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deps-'));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'n');
    const settings = JSON.stringify({ schemaVersion: 1, deploy: { paths: [{ prefix: 'infra/', note: 'n' }] } });
    mkdirSync(path.join(dir, '.factorial'));
    writeFileSync(path.join(dir, '.factorial/pr-body.json'), settings);
    writeFileSync(path.join(dir, 'package.json'), pkg({ old: '1' }));
    mkdirSync(path.join(dir, 'packages/a'), { recursive: true });
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'work');
    writeFileSync(path.join(dir, 'package.json'), pkg({}));
    writeFileSync(path.join(dir, 'packages/a/package.json'), pkg({ 'left-pad': '^1.3.0' }));
    writeFileSync(path.join(dir, 'package-lock.json'), lock);
    git('add', '-A');
    git('commit', '-qm', 'work');
    // The branch under review cannot change the settings that judge it.
    writeFileSync(path.join(dir, '.factorial/pr-body.json'), '{}');
    git('add', '-A');
    git('commit', '-qm', 'tamper');
    // The script works in /workspace/repo; point it at the temporary repository instead.
    const script = depsScript({ baseBranch: 'main' }).replace('cd /workspace/repo', `cd ${dir}`);
    const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    const { files, lockText, settingsText } = parseDeps(stdout);
    assert.equal(parseDeploySettings(settingsText).settings?.paths[0]?.prefix, 'infra/');
    assert.deepEqual(files.map((f) => f.path).sort(), ['package.json', 'packages/a/package.json']);
    const changes = dependencyChanges(files, lockText);
    assert.deepEqual(changes.map((c) => `${c.change}:${c.name}:${c.licence ?? ''}`).sort(), ['added:left-pad:MIT', 'removed:old:']);
  });

  it('rejects output that is not the listing', () => {
    assert.throws(() => parseDeps('garbage line'));
  });
});

describe('testFileChanges', () => {
  it('picks test files by name', () => {
    assert.deepEqual(testFileChanges(['a/b.test.ts', 'c.spec.js', 'tests/x.py', 'src/lib.ts', 'latest/y.ts']), ['a/b.test.ts', 'c.spec.js', 'tests/x.py']);
  });
});
