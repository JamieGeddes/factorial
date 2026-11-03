/**
 * The builder's shell rules (#250): the shell runs commands, and the file
 * tools read, search and change files. The prompt said so and the model kept
 * its habits (PR #259's build: 31 bash calls, 1 edit, 10 python edits), so
 * the host refuses the habits, each with a reason naming the tool to use:
 *
 * - editing a file from the shell: `sed -i`, `perl -i`, `awk -i inplace`,
 *   or an inline python, node, perl or ruby script that writes a file, which
 *   misses silently where the edit tool fails loudly and returns the diff;
 * - writing into the repository by redirection or `tee` (a new file is the
 *   write tool's), and running a one-off script from outside it;
 * - printing or searching the repository's files with cat, head, tail, nl,
 *   `sed -n`, grep, rg or find, which floods the context where read takes
 *   `offset` and `limit` and grep and find cap their results. This one is not
 *   refused (#271: 14 refusals in three builds cost a turn each, and most of
 *   the commands were small): `repositoryRead` says whether a command is one,
 *   and the host appends a note naming the tool to its output. When the
 *   command is only reads (with cd and echo), `steerShellOutput` also cuts
 *   output over its limits to the first and last lines; when it also runs
 *   something else, such as a test, nothing is cut, so a failure in the other
 *   output cannot be lost.
 *
 * A command reading its input from a pipe is not reading files, so
 * `git log | head` and `git ls-files | grep x` stay allowed, as do files
 * outside the repository (/workspace/notes.md, /workspace/logs, /tmp) and
 * its generated directories (node_modules, .git, dist). These steer a
 * cooperative model; they are not an access control, and a determined
 * command can get round them (docs/security.md section 9 has the gates).
 *
 * One more refusal (#283): `git commit` after a check joined to it by `;`, a
 * pipe or anything but `&&`, since the commit then happens whether or not the
 * check passed (a pipe returns the last command's exit code). `CHECK_TOOLS`
 * says what a check is; a command with no check before the commit is allowed.
 */
import path from 'node:path';

import { redirectionsIn, splitHeredocs, unquoted } from './shell-text.ts';
import type { ToolNames } from './tools.ts';

/** Separators between simple commands; a `|` means the next one reads a pipe. */
const SEPARATOR = /(\|\||&&|\|&|\||;|&|\n|\$\(|[()`])/;

/** Separators that let the next command run whatever the one before returned. */
const UNCHAINED = new Set([';', '|', '|&', '||', '&', '\n']);

/** Words that run the command after them. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'command', 'nice', 'nohup', 'exec', 'xargs']);

const INTERPRETER = /^(?:python[\d.]*|node|perl|ruby|deno|bun|tsx|ts-node)$/;
const INLINE_SCRIPT = new Set(['-c', '-e', '--eval', '-p', '--print', '-']);
const SCRIPT_FILE = /\.(?:py|[cm]?[jt]s|pl|rb)$/;

/** A script that writes, renames or deletes a file. */
const WRITES_FILE =
  /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\.write_(?:text|bytes)\s*\(|\b(?:write|append)File(?:Sync)?\b|\bcreateWriteStream\b|\b(?:rename|copyFile|rm|unlink)Sync\b|\bFile\.(?:write|open)\b|\bopen\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*['"]\+?>|\bshutil\.(?:copy|move)|\bos\.(?:rename|replace|remove)\b/;

/**
 * What counts as a check (#283), in one place: a simple command whose name, after wrappers, is one of these.
 * `quiet` and a package manager's `test` or `run <script>` are handled in `isCheck`; this lists the tools.
 */
export const CHECK_TOOLS = {
  /** Package managers: `test`, `t`, `run <script>` and `run-script <script>` are checks; `ci` and `install` are not. */
  packageManagers: new Set(['npm', 'pnpm', 'yarn', 'bun']),
  /** Runners of a tool by name: `npx <tool>` and `pnpm exec <tool>`, and the tool itself. */
  tools: new Set(['tsc', 'eslint', 'vitest', 'jest', 'mocha', 'pytest', 'ruff', 'mypy', 'cfn-lint', 'make']),
  /** Tools that are a check with these subcommands. */
  subcommands: { cargo: new Set(['test', 'clippy', 'build']), go: new Set(['test', 'vet', 'build']) } as Record<string, Set<string>>,
};

const wordsAfterName = (words: string[]) => words.slice(1).filter((w) => !w.startsWith('-'));

/** Whether a simple command's words (wrappers taken out) are a check. */
function isCheck(words: string[]): boolean {
  const name = words[0] ? path.basename(words[0]) : undefined;
  if (name === undefined) return false;
  if (name === 'quiet') return true;
  const rest = wordsAfterName(words);
  if (CHECK_TOOLS.packageManagers.has(name)) {
    if (rest[0] === 'test' || rest[0] === 't') return true;
    if (rest[0] === 'run' || rest[0] === 'run-script') return rest[1] !== undefined;
    if (name === 'pnpm' && rest[0] === 'exec') return rest[1] !== undefined && CHECK_TOOLS.tools.has(path.basename(rest[1]));
    return false;
  }
  if (name === 'npx') return rest[0] !== undefined && CHECK_TOOLS.tools.has(path.basename(rest[0]));
  if (CHECK_TOOLS.tools.has(name)) return true;
  if (name === 'node') return words.includes('--test');
  if (/^python[\d.]*$/.test(name)) return words.some((w, j) => w === '-m' && words[j + 1] === 'pytest');
  const subcommands = CHECK_TOOLS.subcommands[name];
  return subcommands !== undefined && rest[0] !== undefined && subcommands.has(rest[0]);
}

/** Whether the words are `git commit`, with git's own options (`-C <dir>`, `-c <k=v>`) skipped. */
function isGitCommit(words: string[]): boolean {
  if (words[0] === undefined || path.basename(words[0]) !== 'git') return false;
  let i = 1;
  while (i < words.length && words[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[i]!) ? 2 : 1;
  return words[i] === 'commit';
}

const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
/** Commands that print nothing of their own worth keeping whole, so a read chained with them is still a read alone. */
const NEUTRAL = new Set(['cd', 'pushd', 'popd', 'echo', 'printf', 'true', ':']);

/** Options that take the next word as their value, per command. */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
  sed: new Set(['-e', '-f', '-l', '--expression', '--file']),
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--max-count', '--regexp', '--file', '--context']),
  rg: new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-M', '-j', '--glob', '--type', '--type-not', '--max-count', '--regexp', '--file', '--context']),
};

/** Directories in the repository the file tools skip, so the shell may read them. */
const GENERATED = /(?:^|\/)(?:node_modules|\.git|dist|\.next|coverage)(?:\/|$)/;

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A path as the shell would resolve it, or undefined when it is not a plain word or the directory is unknown. */
function resolveIn(cwd: string | undefined, word: string): string | undefined {
  if (word === '' || word === "''" || word === '""' || /[$`*?~{]/.test(word)) return undefined;
  if (path.isAbsolute(word)) return path.normalize(word);
  return cwd === undefined ? undefined : path.resolve(cwd, word);
}

/** The words of one simple command, its redirections taken out, from the command name on. */
function wordsOf(piece: string): string[] {
  const words = piece
    .replace(/<<<?-?\s*\S+/g, ' ')
    .replace(/(?:\d*|&)>>?&?\s*[^\s;&|<>()]*/g, ' ')
    .replace(/<\s*\S+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let start = 0;
  while (start < words.length && (/^\w+=/.test(words[start]!) || WRAPPERS.has(words[start]!) || (start > 0 && WRAPPERS.has(words[start - 1]!) && words[start]!.startsWith('-')))) start++;
  return words.slice(start);
}

/** The operands after the command name: not options, their values or numbers. `skipFirst` drops a pattern or script. */
function operands(name: string, words: string[], skipFirst: boolean): string[] {
  const values = VALUE_OPTIONS[name] ?? new Set<string>();
  const found: string[] = [];
  let skip = skipFirst;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (values.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith('-') && word !== '-') continue;
    if (/^\+?\d+$/.test(word)) continue;
    if (skip) {
      skip = false;
      continue;
    }
    found.push(word);
  }
  return found;
}

const hasShort = (words: string[], letters: RegExp) => words.slice(1).some((w) => new RegExp(`^-[A-Za-z]*${letters.source}`).test(w));

export function builderShellRule(repository: string, command: string, tools: ToolNames): string | undefined {
  return scan(repository, command, tools).refusal;
}

/** A command that reads or searches a repository file: the note naming the tool to use next time, and whether reading is all it does. */
export interface RepositoryRead {
  note: string;
  /** No part prints anything but repository reads (`cd`, `echo` and pipes aside), so its output is safe to cut. */
  alone: boolean;
}

/**
 * Whether the command reads or searches a repository file (not a pipe, not outside the repository or in its
 * generated directories), judged with the same parsing as `builderShellRule`. The host no longer refuses
 * these (#271); it steers them by output size, with `steerShellOutput`.
 */
export function repositoryRead(repository: string, command: string, tools: ToolNames): RepositoryRead | undefined {
  return scan(repository, command, tools).read;
}

function scan(repository: string, command: string, tools: ToolNames): { refusal?: string; read?: RepositoryRead } {
  const editReason = (what: string) =>
    `Change files with the ${tools.edit} tool and create them with ${tools.write}, not by running ${what} in ${tools.shell}: ${tools.edit} fails when its text does not match and returns the diff, where a shell edit misses silently.`;
  const writeReason = (target: string) =>
    `${tools.shell} writes no file in the repository (${target}): create a file with ${tools.write} and change one with ${tools.edit}. Redirection outside the repository, such as appending to /workspace/notes.md, is fine.`;
  const scriptReason = (script: string) =>
    `Run only the repository's own scripts in ${tools.shell}, not ${script}: change files with ${tools.edit} and ${tools.write}, and answer questions about the code with ${tools.read}, ${tools.grep} and ${tools.glob}.`;
  const readReason = (name: string) =>
    `Read the repository's files with the ${tools.read} tool, using \`offset\` and \`limit\` for part of a large one, not by running ${name} in ${tools.shell}: everything printed stays in your context. To run a command over a file, give the command the file.`;
  const searchReason = (name: string) =>
    `Search the repository with the ${tools.grep} tool and find files by name with the ${tools.glob} tool, not by running ${name} in ${tools.shell}. When a question means reading more than two files, ask the explore subagent through ${tools.agent}.`;

  const commitReason =
    `A check joined to git commit by \`;\` or a pipe does not stop the commit when the check fails (a pipe returns the last command's exit code, and \`quiet\` already keeps output short, so \`| tail\` is not needed). Chain them with &&, as \`quiet '<check>' && git commit ...\`, and commit only work a passing check covered, with no file changed since.`;
  const readable = (target: string | undefined) => target !== undefined && isInside(repository, target) && !GENERATED.test(path.relative(repository, target));
  let read: string | undefined;
  // Whether any part prints something other than a repository read: a test run, a build, git, a read elsewhere.
  let other = false;

  // Quoted literal redirection targets are unquoted, so `> "src/a.ts"` is judged too.
  const { shell } = splitHeredocs(command);
  const text = unquoted(shell.replace(/(>>?\s*)(['"])([^'"$`\\\s]+)\2/g, '$1$3')).replace(/&&[ \t]*(?:\\[ \t]*)?\n\s*/g, '&& ');
  const parts = text.split(SEPARATOR);
  let cwd: string | undefined = repository;
  // Whether a check has come before in this command, and whether something other than `&&` followed it.
  let afterCheck = false;
  let unchained = false;

  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i]!;
    const piped = parts[i - 1] === '|' || parts[i - 1] === '|&';
    const words = wordsOf(piece);
    const name = words[0] ? path.basename(words[0]) : undefined;

    for (const { target } of redirectionsIn(piece)) {
      const resolved = resolveIn(cwd, target);
      if (resolved !== undefined && isInside(repository, resolved)) return { refusal: writeReason(`> ${target}`) };
    }
    if (name === undefined) continue;

    if (name === 'cd' || name === 'pushd') {
      cwd = words[1] === undefined ? undefined : resolveIn(cwd, words[1]);
      continue;
    }
    if (name === 'sed' && (hasShort(words, /i/) || words.some((w) => w.startsWith('--in-place')))) return { refusal: editReason('sed -i') };
    if (name === 'perl' && hasShort(words, /i/)) return { refusal: editReason('perl -i') };
    if ((name === 'awk' || name === 'gawk') && words.some((w, j) => w === '-iinplace' || (w === '-i' && words[j + 1] === 'inplace'))) return { refusal: editReason('awk -i inplace') };
    if (INTERPRETER.test(name)) {
      const inline = words.length === 1 || words.slice(1).some((w) => INLINE_SCRIPT.has(w));
      if (inline && WRITES_FILE.test(command)) return { refusal: editReason(`a ${name} script`) };
      const script = words.slice(1).find((w) => SCRIPT_FILE.test(w));
      const resolved = script === undefined ? undefined : resolveIn(cwd, script);
      if (resolved !== undefined && !isInside(repository, resolved)) return { refusal: scriptReason(`${name} ${script}`) };
    }
    if (name === 'tee') {
      for (const target of operands(name, words, false)) {
        const resolved = resolveIn(cwd, target);
        if (resolved !== undefined && isInside(repository, resolved)) return { refusal: writeReason(`tee ${target}`) };
      }
    }

    // A commit after a check that was joined to it by anything but `&&` (`2>&1` is not a separator).
    const separator = parts[i - 1];
    const redirect = separator === '&' && (/[<>]\s*$/.test(parts[i - 2] ?? '') || piece.startsWith('>'));
    if (afterCheck && separator !== undefined && UNCHAINED.has(separator) && !redirect) unchained = true;
    if (unchained && isGitCommit(words)) return { refusal: commitReason };
    if (isCheck(words)) {
      afterCheck = true;
      unchained = false;
    }

    // Reading or searching files, not a pipe: noted, and the scan goes on, since a later part may still be refused.
    if (piped) continue;
    const found = readOrSearch(name, words);
    if (found !== undefined) read ??= found;
    else if (!NEUTRAL.has(name)) other = true;
  }
  return read === undefined ? {} : { read: { note: read, alone: !other } };

  /** The note for a command that prints or searches a repository file, or undefined. */
  function readOrSearch(name: string, words: string[]): string | undefined {
    const quietSed = name === 'sed' && (hasShort(words, /n/) || words.includes('--quiet') || words.includes('--silent'));
    if (READERS.has(name) || quietSed) {
      const files = operands(name, words, quietSed && !words.some((w) => w === '-e' || w === '-f' || w.startsWith('--expression')));
      if (files.some((f) => readable(resolveIn(cwd, f)))) return readReason(quietSed ? 'sed -n' : name);
    }
    if (SEARCHERS.has(name)) {
      const key = name === 'rg' || name === 'ag' || name === 'ack' ? 'rg' : 'grep';
      const patternGiven = words.some((w) => w === '-e' || w === '-f' || w.startsWith('--regexp') || w.startsWith('--file'));
      const paths = operands(key, words, !patternGiven);
      const recursive = key === 'rg' || hasShort(words, /[rR]/) || words.includes('--recursive');
      const searched = paths.length > 0 ? paths : recursive ? ['.'] : [];
      if (searched.some((p) => readable(resolveIn(cwd, p)))) return searchReason(name);
    }
    if (name === 'find') {
      const end = words.findIndex((w, j) => j > 0 && /^[-(!\\]/.test(w));
      const paths = words.slice(1, end === -1 ? undefined : end);
      if ((paths.length > 0 ? paths : ['.']).some((p) => readable(resolveIn(cwd, p)))) return searchReason('find');
    }
    return undefined;
  }
}

/** Output at or under both limits is returned whole (with the note); over either, its edges (#271). */
export const STEER_MAX_LINES = 200;
export const STEER_MAX_BYTES = 16 * 1024;
/** Lines kept from each end of output over the limits: about 40 in all. */
export const STEER_EDGE_LINES = 20;
/** A single line is cut to this many characters in the truncated form, so a minified file cannot fill it. */
const STEER_MAX_LINE = 400;

export interface SteeredOutput {
  text: string;
  truncated: boolean;
  lines: number;
  bytes: number;
}

/**
 * A repository read's output as the model gets it: whole with the note appended, or, over the limits and only
 * when the command did nothing but read, its first and last lines with the counts and how to read the rest.
 */
export function steerShellOutput(output: string, { note, alone }: RepositoryRead, tools: ToolNames): SteeredOutput {
  const bytes = Buffer.byteLength(output);
  const body = output.endsWith('\n') ? output.slice(0, -1) : output;
  const all = body === '' ? [] : body.split('\n');
  const lines = all.length;
  if (!alone || (lines <= STEER_MAX_LINES && bytes <= STEER_MAX_BYTES)) return { text: `${output}${output === '' || output.endsWith('\n') ? '' : '\n'}Note: ${note}`, truncated: false, lines, bytes };

  const cut = (line: string) => (line.length > STEER_MAX_LINE ? `${line.slice(0, STEER_MAX_LINE)}... [line cut at ${STEER_MAX_LINE} characters]` : line);
  const edge = Math.min(STEER_EDGE_LINES, Math.floor(lines / 2));
  // Few but very long lines: all of them, each cut.
  const shown = lines <= 2 * STEER_EDGE_LINES ? all.map(cut) : [...all.slice(0, edge).map(cut), `[... ${lines - 2 * edge} lines omitted ...]`, ...all.slice(lines - edge).map(cut)];
  const which = lines <= 2 * STEER_EDGE_LINES ? `its lines, each cut to ${STEER_MAX_LINE} characters, are shown` : `only its first and last ${edge} lines are shown`;
  const text = [
    ...shown,
    '',
    `The output was ${lines} lines and ${bytes} bytes, over the ${STEER_MAX_LINES} lines and ${STEER_MAX_BYTES} bytes ${tools.shell} returns whole; ${which}. Read the rest with the ${tools.read} tool, using \`offset\` and \`limit\`, or find it with the ${tools.grep} tool. ${note}`,
  ].join('\n');
  return { text, truncated: true, lines, bytes };
}
