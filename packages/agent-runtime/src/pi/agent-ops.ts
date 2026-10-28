/**
 * File operations for pi's tools, run as the agent user (as-agent.ts), never
 * by the root host: `node agent-ops.mjs <op> <args...>`. Bundled beside the
 * host as agent-ops.mjs. Each op prints its result on stdout (raw bytes for
 * read, JSON otherwise) and exits 0, or prints a reason on stderr and exits 1.
 */
import { closeSync, globSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, accessSync, constants, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Directories a search never descends into. */
const SKIPPED = new Set(['.git', 'node_modules']);
const MAX_GREP_FILE_BYTES = 1024 * 1024;

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function isBinary(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Lines matching `pattern` under `root` (a file or a directory), in path order, up to `limit`. */
export function grep(root: string, pattern: RegExp, limit: number, include?: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  const includes = include ? (file: string) => path.matchesGlob(path.basename(file), include) || path.matchesGlob(file, include) : () => true;
  const visit = (target: string): void => {
    if (matches.length >= limit) return;
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(target).sort()) if (!SKIPPED.has(name)) visit(path.join(target, name));
      return;
    }
    if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES || !includes(path.relative(root, target) || path.basename(target)) || isBinary(target)) return;
    const lines = readFileSync(target, 'utf8').split('\n');
    for (const [index, text] of lines.entries()) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        matches.push({ file: target, line: index + 1, text: text.slice(0, 500) });
        if (matches.length >= limit) return;
      }
    }
  };
  visit(root);
  return matches;
}

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
    case 'grep': {
      const [root, source, limit, ignoreCase, include] = args;
      out(grep(root!, new RegExp(source!, ignoreCase === 'true' ? 'i' : ''), Number(limit), include || undefined));
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
