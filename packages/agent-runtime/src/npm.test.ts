import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readConfig, type NpmMirror } from './config.ts';
import { authTokenLine, configureNpm, tokenSeconds, writeNpmrc, type MintToken } from './npm.ts';

const REGISTRY = 'https://factorial-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/factorial-npm/';

const home = () => mkdtempSync(path.join(tmpdir(), 'npm-home-'));

const configFor = (agentHome: string, mirror = true) => ({
  ...readConfig({
    FACTORIAL_ROLE: 'builder',
    FACTORIAL_MODEL: 'm',
    FACTORIAL_EXPLORE_MODEL: 'm',
    FACTORIAL_BACKGROUND_MODEL: 'm',
    FACTORIAL_MAX_TURNS: '150',
    FACTORIAL_RUN_CONTRACT: '1',
    FACTORIAL_MAX_BUDGET_USD: '5',
    FACTORIAL_MAX_DURATION_SECONDS: '6600',
    AWS_REGION: 'eu-west-1',
    ...(mirror
      ? { FACTORIAL_CODEARTIFACT_DOMAIN: 'factorial', FACTORIAL_CODEARTIFACT_DOMAIN_OWNER: '123456789012', FACTORIAL_CODEARTIFACT_REPOSITORY: 'factorial-npm' }
      : {}),
  }),
  agentHome,
});

describe('authTokenLine', () => {
  it("names the registry's host and path, and nothing else", () => {
    assert.equal(authTokenLine(REGISTRY, 'abc.def-ghi'), '//factorial-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/factorial-npm/:_authToken=abc.def-ghi\n');
  });

  it('refuses a token that could start another setting', () => {
    assert.throws(() => authTokenLine(REGISTRY, 'abc\nregistry=https://evil.example/'), /whitespace/);
    assert.throws(() => authTokenLine(REGISTRY, ''), /empty/);
  });
});

describe('writeNpmrc', () => {
  it("writes the file readable by the home's owner alone", () => {
    const dir = home();
    const target = writeNpmrc(dir, 'line\n');
    assert.equal(target, path.join(dir, '.npmrc'));
    assert.equal(readFileSync(target, 'utf8'), 'line\n');
    const stat = statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, statSync(dir).uid);
    assert.equal(stat.gid, statSync(dir).gid);
  });

  it('replaces a file already there', () => {
    const dir = home();
    writeFileSync(path.join(dir, '.npmrc'), 'registry=https://evil.example/\n', { mode: 0o644 });
    writeNpmrc(dir, 'line\n');
    assert.equal(readFileSync(path.join(dir, '.npmrc'), 'utf8'), 'line\n');
    assert.equal(statSync(path.join(dir, '.npmrc')).mode & 0o777, 0o600);
  });

  it('replaces a link rather than writing through it', () => {
    const dir = home();
    const elsewhere = path.join(home(), 'target');
    writeFileSync(elsewhere, 'untouched\n');
    symlinkSync(elsewhere, path.join(dir, '.npmrc'));
    writeNpmrc(dir, 'line\n');
    assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched\n');
    assert.ok(lstatSync(path.join(dir, '.npmrc')).isFile());
  });
});

describe('tokenSeconds', () => {
  it("covers the run's limit with a margin, within CodeArtifact's range", () => {
    assert.equal(tokenSeconds({ maxDurationSeconds: 6600 }), 7500);
    assert.equal(tokenSeconds({ maxDurationSeconds: 1 }), 901);
    assert.equal(tokenSeconds({ maxDurationSeconds: 100_000 }), 43_200);
  });
});

describe('configureNpm', () => {
  it("mints a token for the version's mirror and writes only its line", async () => {
    const dir = home();
    const calls: [NpmMirror, number][] = [];
    const mint: MintToken = async (mirror, seconds) => {
      calls.push([mirror, seconds]);
      return 'token-1';
    };
    assert.equal(await configureNpm(configFor(dir), mint), REGISTRY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0].domain, 'factorial');
    assert.equal(calls[0]![0].domainOwner, '123456789012');
    assert.equal(calls[0]![1], 7500);
    assert.equal(readFileSync(path.join(dir, '.npmrc'), 'utf8'), `//${new URL(REGISTRY).host}/npm/factorial-npm/:_authToken=token-1\n`);
  });

  it('does nothing when the version names no mirror', async () => {
    const dir = home();
    let minted = false;
    assert.equal(await configureNpm(configFor(dir, false), async () => ((minted = true), 't')), undefined);
    assert.equal(minted, false);
    assert.equal(existsSync(path.join(dir, '.npmrc')), false);
  });

  it('fails, writing nothing, when the token cannot be minted', async () => {
    const dir = home();
    await assert.rejects(
      configureNpm(configFor(dir), async () => {
        throw new Error('AccessDeniedException');
      }),
      /AccessDeniedException/,
    );
    assert.equal(existsSync(path.join(dir, '.npmrc')), false);
  });
});
