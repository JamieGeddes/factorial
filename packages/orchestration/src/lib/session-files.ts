/**
 * Export the files the agent leaves in its session to the artefact store:
 * `summary.md`, `notes.md`, `rework.md` and the command logs under
 * `/workspace/logs`. The session is hostile by this point, so everything read
 * from it is untrusted: names are checked before they reach a shell, only
 * regular files are read (never symlinks), sizes are capped by the read
 * itself, and every file is redacted on upload. On the Runtime the reads run
 * as the user the model ran as, so a planted link reaches nothing it could not.
 */
import { putArtefact, putJsonArtefact } from '@factorial/artefacts';

import { asAgent, mustRun, type SessionTarget } from './session.ts';
import { shellQuote } from './shell.ts';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_TOTAL_BYTES = 50 * 1024 * 1024;
/** Raw bytes fetched per command; base64 makes the output a third larger. */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const SECTION = '\n===FACTORIAL-FILE===\n';
const TOP_LEVEL = ['summary.md', 'notes.md', 'rework.md'] as const;
const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export interface SessionFile {
  kind: 'top' | 'log';
  name: string;
  bytes: number;
}

/** List the candidate files and their sizes, one `kind<TAB>name<TAB>bytes` line each. */
export function listScript(): string {
  return [
    'set -uo pipefail',
    `for f in ${TOP_LEVEL.join(' ')}; do p="/workspace/$f"; if [ -f "$p" ] && [ ! -L "$p" ]; then printf 'top\\t%s\\t%s\\n' "$f" "$(stat -c %s "$p")"; fi; done`,
    "if [ -d /workspace/logs ] && [ ! -L /workspace/logs ]; then find /workspace/logs -mindepth 1 -maxdepth 1 -type f -printf 'log\\t%f\\t%s\\n'; fi",
    'exit 0',
  ].join('\n');
}

/** Parse the listing. Lines that do not match exactly, including any unsafe name, are counted and dropped. */
export function parseListing(stdout: string): { files: SessionFile[]; rejected: number } {
  const files: SessionFile[] = [];
  let rejected = 0;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [kind, name = '', size = '', ...rest] = line.split('\t');
    const bytes = Number(size);
    const knownTop = kind === 'top' && (TOP_LEVEL as readonly string[]).includes(name);
    const safeLog = kind === 'log' && LOG_NAME.test(name) && !name.includes('..');
    if (rest.length > 0 || !(knownTop || safeLog) || !Number.isSafeInteger(bytes) || bytes < 0) {
      rejected += 1;
      continue;
    }
    files.push({ kind: kind as SessionFile['kind'], name, bytes });
  }
  return { files, rejected };
}

export interface PlannedFile extends SessionFile {
  /** Where it is stored, under `build/`. */
  path: string;
  /** Bytes to read: the whole file, or its last MAX_FILE_BYTES. */
  readBytes: number;
  truncated: boolean;
}

export interface ExportPlan {
  fetch: PlannedFile[];
  skipped: Array<SessionFile & { reason: string }>;
}

/**
 * Which files to fetch and how much of each. Every file is capped at
 * MAX_FILE_BYTES, keeping its end, where a log's errors are. Logs are taken
 * in name order (quiet numbers them) until MAX_LOG_TOTAL_BYTES; the rest are
 * skipped and listed.
 */
export function planExport(files: readonly SessionFile[]): ExportPlan {
  const fetch: PlannedFile[] = [];
  const skipped: ExportPlan['skipped'] = [];
  const capped = (file: SessionFile, path: string): PlannedFile => {
    const readBytes = Math.min(file.bytes, MAX_FILE_BYTES);
    return { ...file, path, readBytes, truncated: readBytes < file.bytes };
  };
  for (const file of files.filter((f) => f.kind === 'top')) {
    fetch.push(capped(file, `build/${file.name}`));
  }
  let logTotal = 0;
  const logs = files.filter((f) => f.kind === 'log').sort((a, b) => a.name.localeCompare(b.name));
  for (const file of logs) {
    const planned = capped(file, `build/logs/${file.name}`);
    if (logTotal + planned.readBytes > MAX_LOG_TOTAL_BYTES) {
      skipped.push({ ...file, reason: `over the ${MAX_LOG_TOTAL_BYTES}-byte total for logs` });
      continue;
    }
    logTotal += planned.readBytes;
    fetch.push(planned);
  }
  return { fetch, skipped };
}

function sourcePath(file: SessionFile): string {
  return file.kind === 'top' ? `/workspace/${file.name}` : `/workspace/logs/${file.name}`;
}

/** Group files so each command returns at most MAX_BATCH_BYTES of raw data. */
export function batches(files: readonly PlannedFile[]): PlannedFile[][] {
  const groups: PlannedFile[][] = [];
  let current: PlannedFile[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.readBytes > MAX_BATCH_BYTES) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.readBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Print each file's size at read time and its last `readBytes` as base64, one
 * `ok:<size>:<base64>` section per file; `missing:` if it is gone or no longer
 * a regular file. The size is taken at read time because the file may have
 * grown since the listing.
 */
export function fetchScript(files: readonly PlannedFile[]): string {
  const lines = ['set -uo pipefail'];
  files.forEach((file, i) => {
    if (i > 0) lines.push(`printf '%s' ${shellQuote(SECTION)}`);
    const path = shellQuote(sourcePath(file));
    lines.push(
      `if [ -f ${path} ] && [ ! -L ${path} ]; then printf 'ok:%s:' "$(stat -c %s -- ${path})"; tail -c ${file.readBytes} -- ${path} | base64 -w0; else printf 'missing:'; fi`,
    );
  });
  lines.push('exit 0');
  return lines.join('\n');
}

export interface FetchedFile {
  content: Buffer;
  /** The file's size when it was read. */
  size: number;
}

/** The file contents from a fetch, in order; undefined where a file had gone. */
export function parseFetch(stdout: string, count: number): Array<FetchedFile | undefined> {
  const sections = stdout.split(SECTION);
  if (sections.length !== count) {
    throw new Error(`expected ${count} files from the session, got ${sections.length}`);
  }
  return sections.map((section) => {
    if (section.startsWith('missing:')) return undefined;
    const match = /^ok:([0-9]+):([A-Za-z0-9+/=]*)\s*$/.exec(section);
    if (!match) throw new Error('session file export did not produce base64 output');
    return { content: Buffer.from(match[2] ?? '', 'base64'), size: Number(match[1]) };
  });
}

/**
 * A file read from its end starts mid-line, possibly mid-credential, where
 * redaction cannot recognise what is left. Drop that partial line.
 */
export function dropPartialFirstLine(content: Buffer): Buffer {
  const newline = content.indexOf(0x0a);
  return newline === -1 ? Buffer.alloc(0) : content.subarray(newline + 1);
}

function contentType(path: string): string {
  return path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
}

export interface ExportSummary {
  stored: number;
  storedBytes: number;
  skipped: number;
}

/**
 * Read the agent's files out of its session and store them, redacted, under
 * `build/`, with `build/logs/index.json` saying what was stored, truncated or
 * skipped.
 */
export async function exportSessionFiles(target: SessionTarget, prefix: string): Promise<ExportSummary> {
  const listing = await mustRun(target, asAgent(listScript()), 120);
  const { files, rejected } = parseListing(listing.stdout);
  const plan = planExport(files);
  const stored: Array<{ name: string; path: string; bytes: number; storedBytes: number; truncated: boolean }> = [];
  const gone: string[] = [];
  for (const group of batches(plan.fetch)) {
    const result = await mustRun(target, asAgent(fetchScript(group)), 300);
    const contents = parseFetch(result.stdout, group.length);
    for (const [i, file] of group.entries()) {
      const fetched = contents[i];
      if (!fetched) {
        gone.push(file.name);
        continue;
      }
      // Decided from the size at read time: a file that grew after the
      // listing was read from its end too.
      const truncated = fetched.size > fetched.content.length;
      const kept = truncated ? dropPartialFirstLine(fetched.content) : fetched.content;
      await putArtefact(prefix, file.path, kept.toString('utf8'), contentType(file.path));
      stored.push({ name: file.name, path: file.path, bytes: fetched.size, storedBytes: kept.length, truncated });
    }
  }
  await putJsonArtefact(prefix, 'build/logs/index.json', {
    maxFileBytes: MAX_FILE_BYTES,
    maxLogTotalBytes: MAX_LOG_TOTAL_BYTES,
    stored,
    skipped: [
      ...plan.skipped.map(({ name, bytes, reason }) => ({ name, bytes, reason })),
      ...gone.map((name) => ({ name, reason: 'gone before it could be read' })),
    ],
    ...(rejected > 0 ? { rejectedEntries: rejected } : {}),
  });
  return {
    stored: stored.length,
    storedBytes: stored.reduce((sum, file) => sum + file.storedBytes, 0),
    skipped: plan.skipped.length + gone.length + rejected,
  };
}
