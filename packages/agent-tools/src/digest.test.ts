import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { digest, looksLikeFailure, slug, type DigestOptions } from './digest.ts';

const numbered = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('digest', () => {
  it('shows only the exit code, log path and last few lines on success', () => {
    const text = digest({ command: 'npm test', exitCode: 0, output: `${numbered(500)}\n`, logPath: '/workspace/logs/001-npm-test.log' });
    assert.match(text, /^\$ npm test\nexit 0 · 500 lines · full output: \/workspace\/logs\/001-npm-test\.log\n/);
    assert.match(text, /--- last 5 lines ---\nline 496\n/);
    assert.doesNotMatch(text, /line 495\n/);
  });

  it('on failure shows failure lines from before the tail, then a longer tail', () => {
    const output = ['ok 1 - parses', 'not ok 2 - rejects bad input', ...numbered(100).split('\n'), 'Error: boom'].join('\n');
    const text = digest({ command: 'npm test', exitCode: 1, output, logPath: 'l' });
    assert.match(text, /--- failure lines before the tail \(1 of 1\) ---\nnot ok 2 - rejects bad input\n/);
    assert.match(text, /--- last 30 lines ---/);
    assert.match(text, /Error: boom\n$/);
    assert.doesNotMatch(text, /ok 1 - parses/);
  });

  it('caps the failure lines and cuts long lines', () => {
    const options: DigestOptions = { tailOnFailure: 1, tailOnSuccess: 1, maxMatches: 2, maxLineLength: 10 };
    const output = ['error one is long', 'error two', 'error three', 'end'].join('\n');
    const text = digest({ command: 'x', exitCode: 2, output, logPath: 'l', options });
    assert.match(text, /\(2 of 3\) ---\nerror one  …\nerror two\n--- last 1 lines ---\nend\n$/);
  });

  it('strips colour sequences and npm notices, and keeps the failure lines', () => {
    const red = (text: string): string => `\x1b[31m${text}\x1b[39m`;
    const output = [
      `\x1b[1m\x1b[46m RUN \x1b[49m\x1b[22m v3.2.4`,
      ` ${red('×')} src/a.test.ts > parses ${red('2ms')}`,
      `\x1b[31m\x1b[1mAssertionError\x1b[22m: expected 1 to be 2\x1b[39m`,
      ...numbered(40).split('\n'),
      'npm notice',
      'npm notice New major version of npm available! 10.9.9 -> 12.2.1',
      'npm notice To update run: npm install -g npm@12.2.1',
      ` Test Files  ${red('1 failed')} (1)`,
      'progress 10%\rprogress 100%',
    ].join('\n');
    const text = digest({ command: 'npx vitest run', exitCode: 1, output, logPath: 'l' });
    assert.doesNotMatch(text, /\x1b/);
    assert.doesNotMatch(text, /npm notice|New major version/);
    assert.match(text, /exit 1 · 48 lines/);
    assert.match(text, /--- failure lines before the tail \(1 of 1\) ---\nAssertionError: expected 1 to be 2\n/);
    assert.match(text, /Test Files {2}1 failed \(1\)\nprogress 100%\n$/);
  });

  it('reports empty output as zero lines with no sections', () => {
    assert.equal(digest({ command: 'true', exitCode: 0, output: '', logPath: 'l' }), '$ true\nexit 0 · 0 lines · full output: l\n');
  });
});

describe('looksLikeFailure', () => {
  it('matches common failure lines', () => {
    for (const line of ['not ok 3 - x', 'npm ERR! code 1', "error TS2322: Type 'x'", 'AssertionError [ERR_ASSERTION]', '✖ fails', 'Tests: 2 failed']) {
      assert.ok(looksLikeFailure(line), line);
    }
  });

  it('matches failure lines from other toolchains', () => {
    for (const line of [
      'FAILED tests/test_api.py::test_get - assert 404 == 200',
      'E       assert 404 == 200',
      'Traceback (most recent call last):',
      '--- FAIL: TestParse (0.00s)',
      '    parse_test.go:12: got 1, want 2',
      "thread 'tests::parse' panicked at src/lib.rs:10:5:",
      'error[E0308]: mismatched types',
      '[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0',
      'fatal: not a git repository',
    ]) {
      assert.ok(looksLikeFailure(line), line);
    }
  });

  it('ignores summaries that report no failures', () => {
    for (const line of [
      '# fail 0',
      'fail: 0',
      '12 passed, 0 failed',
      'ok 1 - handles bad input',
      'Tests run: 4, Failures: 0, Errors: 0, Skipped: 0',
      'test result: ok. 5 passed; 0 failed; 0 ignored',
      '===== 5 passed in 0.12s =====',
    ]) {
      assert.ok(!looksLikeFailure(line), line);
    }
  });

  it('matches a summary that reports a failure beside a count of none', () => {
    assert.ok(looksLikeFailure('1 error, 0 failed'));
  });
});

describe('slug', () => {
  it('makes a short file-name-safe name', () => {
    assert.equal(slug('npm test -w @factorial/workitem'), 'npm-test-w-factorial-workitem');
    assert.equal(slug('&&&'), 'command');
    assert.ok(slug('a'.repeat(100)).length <= 40);
  });
});
