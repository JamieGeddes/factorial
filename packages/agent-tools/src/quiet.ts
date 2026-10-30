/**
 * quiet: run a shell command, keep its full output in a log file and print
 * only a short report (see digest.ts).
 *
 *   quiet make test
 *   quiet 'pip install -r requirements.txt && pytest -x'
 *
 * The arguments are joined and run with `bash -o pipefail -c`, and quiet exits
 * with the command's exit code. Logs go to $QUIET_LOG_DIR (default
 * /workspace/logs), outside the repository.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { digest, slug } from './digest.ts';

const command = process.argv.slice(2).join(' ').trim();
if (command === '') {
  process.stderr.write('usage: quiet <command...>\n');
  process.exit(2);
}

const logDir = process.env.QUIET_LOG_DIR ?? '/workspace/logs';
mkdirSync(logDir, { recursive: true });
const sequence = String(readdirSync(logDir).length + 1).padStart(3, '0');
const logPath = join(logDir, `${sequence}-${slug(command)}.log`);

const child = spawn('bash', ['-o', 'pipefail', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
const chunks: Buffer[] = [];
child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
child.on('close', (code, signal) => {
  const output = Buffer.concat(chunks).toString('utf8');
  writeFileSync(logPath, output);
  const exitCode = code ?? (signal ? 128 : 1);
  process.stdout.write(digest({ command, exitCode, output, logPath }));
  process.exit(exitCode);
});
