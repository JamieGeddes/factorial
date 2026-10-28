/**
 * File operations for pi's tools, run as the agent user (as-agent.ts), never
 * by the root host: `node agent-ops.mjs <op> <args...>`. Bundled beside the
 * host as agent-ops.mjs. Each op prints its result on stdout (raw bytes for
 * read, JSON otherwise) and exits 0, or prints a reason on stderr and exits 1.
 */
import { accessSync, constants, globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Directories a glob never descends into. */
const SKIPPED = new Set(['.git', 'node_modules']);

function main(argv: string[]): number {
  const [op, ...args] = argv;
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value));
  switch (op) {
    case 'read':
      process.stdout.write(readFileSync(args[0]!));
      return 0;
    case 'write':
      writeFileSync(args[0]!, readFileSync(0));
      return 0;
    case 'mkdir':
      mkdirSync(args[0]!, { recursive: true });
      return 0;
    case 'access':
      accessSync(args[0]!, args[1] === 'rw' ? constants.R_OK | constants.W_OK : constants.R_OK);
      return 0;
    case 'exists':
      out(statSync(args[0]!, { throwIfNoEntry: false }) !== undefined);
      return 0;
    case 'isdir':
      out(statSync(args[0]!, { throwIfNoEntry: false })?.isDirectory() ?? false);
      return 0;
    case 'readdir':
      out(readdirSync(args[0]!));
      return 0;
    case 'glob': {
      const [cwd, pattern, limit, ignore] = args;
      const excluded = (JSON.parse(ignore ?? '[]') as string[]).concat([...SKIPPED].map((name) => `**/${name}/**`));
      const files = globSync(pattern!, { cwd: cwd!, exclude: (name: string) => excluded.some((glob) => path.matchesGlob(name, glob)) || SKIPPED.has(path.basename(name)) });
      out(files.sort().slice(0, Number(limit)));
      return 0;
    }
    default:
      process.stderr.write(`unknown op ${String(op)}`);
      return 1;
  }
}

if (process.argv[1] && /agent-ops\.(?:mjs|ts)$/.test(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
