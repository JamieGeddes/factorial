/**
 * `npm run dashboard`: starts the command centre on 127.0.0.1 only, with a
 * fresh random token, and prints the URL that carries it. The first request
 * exchanges the token for a cookie (`src/server/guard.ts`); nothing without
 * the cookie is served.
 *
 * The server uses the caller's AWS credentials through the SDK's default
 * chain (AWS_PROFILE, SSO, environment variables). Builds the app first when
 * no build exists; `--dev` runs the development server instead.
 *
 * Ctrl-C stops it: the signal goes to the server, and if the server is still
 * running 5 seconds later it is killed (`shutdown.ts`).
 *
 * Environment: DASHBOARD_PORT (default 4757), and the overrides listed in
 * docs/dashboard.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createShutdown } from './shutdown.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const dev = process.argv.includes('--dev');
const port = process.env.DASHBOARD_PORT ?? '4757';
if (!/^\d{2,5}$/.test(port)) throw new Error(`DASHBOARD_PORT "${port}" is not a port`);

const env = { ...process.env, DASHBOARD_PORT: port, DASHBOARD_TOKEN: randomBytes(24).toString('base64url'), NEXT_TELEMETRY_DISABLED: '1' };

if (!dev && !existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.log('No build found: building the command centre first.');
  const build = spawnSync(process.execPath, [next, 'build'], { cwd: root, env, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const child = spawn(process.execPath, [next, dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', port], { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });

let printed = false;
child.stdout.on('data', (data: Buffer) => {
  process.stdout.write(data);
  if (!printed && /Ready|started server|Local:/i.test(data.toString())) {
    printed = true;
    console.log(`\nFactorial command centre: http://127.0.0.1:${port}/?token=${env.DASHBOARD_TOKEN}\n(the token is new on every start; open this URL, nothing else is served)\n`);
  }
});

// Ctrl-C or SIGTERM goes to the server, which ends its live streams and exits.
// If it is still running 5 seconds later it is killed; a second Ctrl-C kills it
// at once. The server is read-only and holds no state, so this loses nothing.
const shutdown = createShutdown({
  forward: (signal) => child.kill(signal),
  kill: () => child.kill('SIGKILL'),
  exit: (code) => process.exit(code),
  timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown.signal(signal));
child.on('exit', (code) => shutdown.exited(code));
