import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderShellRule, repositoryRead, steerShellOutput, STEER_EDGE_LINES, STEER_MAX_BYTES, STEER_MAX_LINES } from './builder-shell.ts';
import { PI_TOOLS } from './pi/tools.ts';
import { HOST_ROLES } from './roles.ts';

const REPO = '/workspace/repo';
const rule = (command: string) => builderShellRule(REPO, command, PI_TOOLS);
const read = (command: string) => repositoryRead(REPO, command, PI_TOOLS);
const refused = (command: string) => rule(command) !== undefined;

describe('builderShellRule (#250)', () => {
  it('allows commands: git, quiet, installs, the repository scripts, listings', () => {
    for (const command of [
      'git status --short; git add -A packages && git commit -qm "Add the helpers" && echo ok',
      "quiet 'npm run ci' 2>&1 | tail -25",
      "cd /workspace/repo/packages/dashboard; quiet 'npm test' 2>&1 | tail -12",
      'git log --oneline | head -5; ls',
      'git diff --stat main...HEAD',
      'git show HEAD:package.json | jq .scripts',
      "git ls-files | grep -n 'Table'",
      'node scripts/check-workflows.ts',
      'node --test packages/a/src/a.test.ts',
      "node -e \"console.log(require('./package.json').version)\"",
      "python3 -c \"import json; print(json.load(open('package.json'))['name'])\"",
      'npx tsc --noEmit > /tmp/tsc.txt 2>&1; wc -l /tmp/tsc.txt',
      'git commit -m "Refuse cat > src/a.ts and sed -i in the shell"',
      "git commit -F - <<'EOF'\nRead files with cat src/a.ts\n\nfind . -name x > out\nEOF",
    ]) {
      assert.equal(rule(command), undefined, command);
    }
  });

  it('allows reading and writing outside the repository: notes, logs, plan files, /tmp', () => {
    for (const command of [
      'cat /workspace/notes.md | head -50; ls /workspace',
      "cat >> /workspace/notes.md <<'EOF'\nAll 6 plan steps done; cat src/a.ts > b\nEOF",
      "jq -c '.steps[]' /workspace/plan.json",
      'tail -5 /workspace/logs/003-npm-test.log',
      'grep -m5 -n "Error\\|Cannot" /workspace/logs/$(ls -t /workspace/logs | head -1)',
      'cd /workspace && cat >> notes.md <<E\nx\nE',
      'echo x | tee /tmp/a.txt',
      'cat /proc/self/status',
    ]) {
      assert.equal(rule(command), undefined, command);
    }
  });

  it('allows reading and searching generated directories the file tools skip', () => {
    for (const command of ['grep -rn "export declare function" node_modules/@aws-sdk/client-s3/dist-types | head', 'find dist -name "*.js"', 'cat .git/HEAD']) {
      assert.equal(rule(command), undefined, command);
    }
  });

  it('refuses editing a file from the shell', () => {
    for (const command of [
      "sed -i 's/a/b/' src/a.ts",
      "sed -i.bak -e 's/a/b/' src/a.ts",
      "sed --in-place 's/a/b/' src/a.ts",
      "perl -pi -e 's/a/b/' src/a.ts",
      'gawk -i inplace \'{print}\' src/a.ts',
      "cd /workspace/repo/packages/dashboard; python3 - <<'EOF'\np='src/lib/work-items.ts'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF",
      "python3 <<EOF\nfrom pathlib import Path\nPath('src/a.ts').write_text('x')\nEOF",
      "node -e \"require('fs').writeFileSync('src/a.ts', 'x')\"",
      "python3 -c \"open('src/a.ts', 'a').write('x')\"",
    ]) {
      const reason = rule(command);
      assert.ok(reason?.includes(`Change files with the ${PI_TOOLS.edit} tool`), command);
    }
  });

  it('refuses writing into the repository by redirection or tee', () => {
    for (const command of [
      "cd /workspace/repo/packages/dashboard; cat > src/components/table.test.tsx <<'EOF'\nimport x from 'y';\nEOF",
      "cat <<'EOF' > /workspace/repo/src/a.ts\nx\nEOF",
      'echo x >> README.md',
      'echo x > "src/a.ts"',
      'npm run build > build.log',
      'echo x | tee src/a.ts',
      'echo x | tee -a /workspace/repo/a.txt',
      'cd packages/a && echo x > b.ts',
    ]) {
      const reason = rule(command);
      assert.ok(reason?.includes(`create a file with ${PI_TOOLS.write}`), command);
    }
  });

  it('refuses running a one-off script from outside the repository', () => {
    for (const command of ['python3 /workspace/fix.py', 'node /tmp/edit.mjs', 'cd /workspace && python3 fix.py']) {
      assert.ok(rule(command)?.startsWith("Run only the repository's own scripts"), command);
    }
  });

  it("does not refuse printing the repository's files, and notes it as a read", () => {
    for (const command of [
      'cd /workspace/repo; cat CLAUDE.md | head -40',
      'cat src/components/Table.tsx src/components/run/RunsTable.tsx',
      'sed -n 195,260p src/lib/work-items.ts',
      'sed -n -e 1,40p src/a.ts',
      'head -n 30 src/lib/work-items.test.ts',
      'tail -20 /workspace/repo/docs/dashboard.md',
      'nl -ba src/a.ts',
      'x=$(cat package.json)',
      'head -c 600 cfn-lint-requirements.txt',
    ]) {
      assert.equal(rule(command), undefined, command);
      assert.ok(read(command)?.includes(`Read the repository's files with the ${PI_TOOLS.read} tool`), command);
    }
  });

  it("does not refuse searching the repository's files, and notes it as a search", () => {
    for (const command of [
      'grep -n "compareItems\\|newestFirst" -r src | head -20',
      'grep -n "matchesFilter" -A12 src/lib/work-items.ts | head -90',
      'grep -n "lint:cfn" package.json',
      'grep -rn x',
      "rg -n 'Table' packages",
      'rg Table',
      'find . -name "*.test.ts"',
      'find packages/dashboard/src -type f',
      'grep -e x -e y src/a.ts',
    ]) {
      assert.equal(rule(command), undefined, command);
      const note = read(command);
      assert.ok(note?.includes(`Search the repository with the ${PI_TOOLS.grep} tool`), command);
      assert.ok(note?.includes(PI_TOOLS.agent), command);
    }
  });

  it('notes no read for a pipe, a path outside the repository or a generated directory', () => {
    for (const command of [
      'git log --oneline | head -5',
      "git ls-files | grep -n 'Table'",
      'git show HEAD:package.json | jq .scripts',
      'cat /workspace/notes.md | head -50; ls /workspace',
      'tail -5 /workspace/logs/003-npm-test.log',
      'grep -rn "export" node_modules/@aws-sdk/client-s3/dist-types | head',
      'find dist -name "*.js"',
      'cat .git/HEAD',
      'cd /tmp && cat a.txt',
      'ls; jq .name package.json',
    ]) {
      assert.equal(read(command), undefined, command);
    }
  });

  it('judges each command in a chain, with the directory cd sets', () => {
    assert.equal(read('cd /tmp && cat a.txt && echo x > b.txt'), undefined);
    assert.equal(refused('cd /tmp && cat a.txt && echo x > b.txt'), false);
    assert.equal(refused('cd /tmp && cat a.txt; cd /workspace/repo && cat a.txt'), false);
    assert.ok(read('cd /tmp && cat a.txt; cd /workspace/repo && cat a.txt'));
    assert.equal(read('cd "$DIR" && cat a.txt'), undefined);
    assert.ok(read('git status && sed -n 1,8p packages/dashboard/src/app/globals.css'));
  });

  it('still refuses an edit or write in a command that also reads', () => {
    assert.ok(rule("cat src/a.ts && sed -i 's/a/b/' src/a.ts")?.includes(`Change files with the ${PI_TOOLS.edit} tool`));
    assert.ok(rule('cat src/a.ts > src/b.ts')?.includes(`create a file with ${PI_TOOLS.write}`));
    assert.ok(rule('grep -rn x src; python3 /tmp/fix.py')?.startsWith("Run only the repository's own scripts"));
  });

  describe('steerShellOutput (#271)', () => {
    const NOTE = 'Use the read tool next time.';
    const steer = (output: string) => steerShellOutput(output, NOTE, PI_TOOLS);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    it('returns output at the limits whole, with the note on a line of its own', () => {
      const output = lines(STEER_MAX_LINES);
      const steered = steer(output);
      assert.equal(steered.truncated, false);
      assert.equal(steered.lines, STEER_MAX_LINES);
      assert.equal(steered.text, `${output}Note: ${NOTE}`);
      assert.equal(steer('no newline').text, `no newline\nNote: ${NOTE}`);
      assert.equal(steer('').text, `Note: ${NOTE}`);
    });

    it('cuts output over the line limit to its first and last lines, with the counts and the instruction', () => {
      const steered = steer(lines(STEER_MAX_LINES + 1));
      assert.equal(steered.truncated, true);
      assert.equal(steered.lines, STEER_MAX_LINES + 1);
      const text = steered.text.split('\n');
      assert.equal(text[0], 'line 1');
      assert.ok(text.includes(`line ${STEER_EDGE_LINES}`));
      assert.ok(!text.includes(`line ${STEER_EDGE_LINES + 1}`));
      assert.ok(text.includes(`line ${STEER_MAX_LINES + 1}`));
      assert.ok(!text.includes('line 100'));
      assert.ok(steered.text.includes(`${STEER_MAX_LINES + 1} lines and ${steered.bytes} bytes`));
      assert.ok(steered.text.includes(`${PI_TOOLS.read} tool, using \`offset\` and \`limit\``));
      assert.ok(steered.text.includes(PI_TOOLS.grep));
      assert.ok(steered.text.includes(NOTE));
    });

    it('cuts output over the byte limit, and a very long line', () => {
      const wide = `${'x'.repeat(STEER_MAX_BYTES)}\n`;
      const steered = steer(wide);
      assert.equal(steered.truncated, true);
      assert.equal(steered.bytes, STEER_MAX_BYTES + 1);
      assert.ok(steered.text.length < 2000);
      assert.ok(steered.text.includes('[line cut at'));
    });
  });

  it('steers a repository read through the builder policy and logs it', () => {
    const notes: Array<[string, Record<string, unknown>]> = [];
    const policy = HOST_ROLES.builder.session({ workspace: '/workspace', repository: REPO }, (message, fields) => notes.push([message, fields]), PI_TOOLS);
    assert.equal(policy.decide({ kind: 'shell', command: 'sed -n 1,60p src/now.tsx' }).allow, true);
    const small = policy.afterShellResult?.('sed -n 1,60p src/now.tsx', 'a\nb\n');
    assert.ok(small?.startsWith('a\nb\nNote: Read the repository'));
    const large = policy.afterShellResult?.('cat package-lock.json', 'x\n'.repeat(500));
    assert.ok(large?.includes('500 lines'));
    assert.deepEqual(notes, [
      ['shell read steered', { truncated: false, lines: 2, bytes: 4 }],
      ['shell read steered', { truncated: true, lines: 500, bytes: 1000 }],
    ]);
    assert.equal(policy.afterShellResult?.('git log | head -5', 'abc'), undefined);
    assert.equal(policy.afterShellResult?.('cat /workspace/notes.md', 'abc'), undefined);
    assert.equal(notes.length, 2);
  });

  it('reaches the builder through its policy, after the shared rules', () => {
    const policy = HOST_ROLES.builder.session({ workspace: '/workspace', repository: REPO }, () => {}, PI_TOOLS);
    const decision = policy.decide({ kind: 'shell', command: "sed -i 's/a/b/' src/a.ts" });
    assert.ok(!decision.allow && decision.reason.includes(PI_TOOLS.edit));
    const push = policy.decide({ kind: 'shell', command: 'git push origin HEAD' });
    assert.ok(!push.allow && /orchestrator pushes/.test(push.reason));
    assert.equal(policy.decide({ kind: 'shell', command: "quiet 'npm test'" }).allow, true);
  });

  it("leaves the reviewer's shell to its own rules", () => {
    const policy = HOST_ROLES.reviewer.session({ workspace: '/workspace', repository: REPO }, () => {}, PI_TOOLS);
    assert.equal(policy.decide({ kind: 'shell', command: 'sed -n 10,40p src/a.ts' }).allow, true);
  });
});
