import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assembleSeed, seedScript, type SeedProvider } from './seed.ts';
import { contextFor, newItem } from './seed-fixtures.ts';
import { diffProvider } from './seed-providers.ts';

// The script uses GNU `stat -c`, as it runs in the Linux session.
const linux = process.platform === 'linux';

const HOSTILE = `it's "quoted" $(touch INJECTED) \`touch INJECTED\` $HOME \\n ünïcode 日本語\n`;
const CONTENT_CAP = 200;
const COMMAND_CAP = 100;

describe('seedScript, run with bash', { skip: !linux }, () => {
  let root = '';
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: join(root, 'repo'),
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'seed-script-'));
    mkdirSync(join(root, 'repo'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'repo', 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // What a clone has: the base branch as a remote-tracking ref, here with a slash in its name.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('update-ref', 'refs/remotes/origin/release/1', 'HEAD');
    git('checkout', '-q', '-b', 'work');
    writeFileSync(join(root, 'repo', 'a.txt'), "one\ntwo 'quoted' $(x)\n");
    writeFileSync(join(root, 'repo', 'big.txt'), 'x'.repeat(5000));
    git('add', '.');
    git('commit', '-q', '-m', 'work');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  /** Run the real script with /workspace pointed at the temporary directory. */
  const run = (script: string) =>
    spawnSync('bash', ['-c', script.replaceAll('/workspace', root)], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

  const bigCommand: SeedProvider = () => ({ files: [{ path: 'big.out', command: 'cat big.txt', cap: COMMAND_CAP }] });
  const hostile: SeedProvider = () => ({
    files: [
      { path: 'hostile.md', content: HOSTILE, cap: 1000 },
      { path: 'long.md', content: 'y'.repeat(1000), cap: CONTENT_CAP, truncate: true },
    ],
  });

  it('places content byte for byte, a command file as the command prints it, and cuts both at their caps', async () => {
    const seed = await assembleSeed([hostile, diffProvider, bigCommand], contextFor(newItem));
    const result = run(seedScript(seed));
    assert.equal(result.status, 0, result.stderr);

    assert.equal(readFileSync(join(root, 'hostile.md'), 'utf8'), HOSTILE);
    assert.equal(existsSync(join(root, 'INJECTED')), false);
    assert.equal(existsSync(join(root, 'repo', 'INJECTED')), false);

    assert.ok(statSync(join(root, 'long.md')).size <= CONTENT_CAP);
    assert.match(readFileSync(join(root, 'long.md'), 'utf8'), /Cut at 200 bytes/);

    assert.equal(statSync(join(root, 'big.out')).size, COMMAND_CAP);
    assert.equal(readFileSync(join(root, 'big.out'), 'utf8'), 'x'.repeat(COMMAND_CAP));

    const diff = readFileSync(join(root, 'diff.patch'), 'utf8');
    assert.equal(diff, git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', 'origin/main...HEAD'));
    assert.match(diff, /\+two 'quoted' \$\(x\)/);
  });

  it('diffs against a base branch with a slash in its name', async () => {
    const seed = await assembleSeed([diffProvider], contextFor(newItem, { baseBranch: 'release/1' }));
    const result = run(seedScript(seed));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'diff.patch'), 'utf8'), git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', 'origin/release/1...HEAD'));
  });

  it('fails when the base ref does not exist, so a wrong ref is not seeded as an empty diff', async () => {
    const seed = await assembleSeed([diffProvider], contextFor(newItem, { baseBranch: 'nope' }));
    const result = run(seedScript(seed));
    assert.notEqual(result.status, 0);
  });
});
