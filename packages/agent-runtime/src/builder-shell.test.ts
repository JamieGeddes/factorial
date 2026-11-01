import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderShellRule } from './builder-shell.ts';
import { PI_TOOLS } from './pi/tools.ts';
import { HOST_ROLES } from './roles.ts';

const REPO = '/workspace/repo';
const rule = (command: string) => builderShellRule(REPO, command, PI_TOOLS);
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

  it("refuses printing the repository's files", () => {
    for (const command of [
      'cd /workspace/repo; cat CLAUDE.md | head -40',
      'cat src/components/Table.tsx src/components/run/RunsTable.tsx',
      'sed -n 195,260p src/lib/work-items.ts',
      'sed -n -e 1,40p src/a.ts',
      'head -n 30 src/lib/work-items.test.ts',
      'tail -20 /workspace/repo/docs/dashboard.md',
      'nl -ba src/a.ts',
      'x=$(cat package.json)',
    ]) {
      assert.ok(rule(command)?.includes(`Read the repository's files with the ${PI_TOOLS.read} tool`), command);
    }
  });

  it("refuses searching the repository's files", () => {
    for (const command of [
      'grep -n "compareItems\\|newestFirst" -r src | head -20',
      'grep -n "matchesFilter" -A12 src/lib/work-items.ts | head -90',
      'grep -rn x',
      "rg -n 'Table' packages",
      'rg Table',
      'find . -name "*.test.ts"',
      'find packages/dashboard/src -type f',
      'grep -e x -e y src/a.ts',
    ]) {
      const reason = rule(command);
      assert.ok(reason?.includes(`Search the repository with the ${PI_TOOLS.grep} tool`), command);
      assert.ok(reason?.includes(PI_TOOLS.agent), command);
    }
  });

  it('judges each command in a chain, with the directory cd sets', () => {
    assert.equal(refused('cd /tmp && cat a.txt && echo x > b.txt'), false);
    assert.equal(refused('cd /tmp && cat a.txt; cd /workspace/repo && cat a.txt'), true);
    assert.equal(refused('cd "$DIR" && cat a.txt'), false);
    assert.equal(refused('git status && sed -n 1,8p packages/dashboard/src/app/globals.css'), true);
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
