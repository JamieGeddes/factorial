import { looksLikeFailure, plainLines } from '@factorial/agent-tools/digest';

/** Lines from the end of a log that are always shown. */
export const TAIL_LINES = 200;
/** Most lines one failure's block keeps. */
export const MAX_FAILURE_LINES = 30;
/** Most bytes one failure's block keeps. */
export const MAX_FAILURE_BYTES = 3 * 1024;
/** Lines of a TAP `stack:` kept. */
export const STACK_LINES = 5;
/** Longest line shown; longer lines are cut. */
export const MAX_LINE_LENGTH = 300;

// GitHub prefixes every log line with a timestamp (and the first with a BOM).
const TIMESTAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/gm;
const TAP_NOT_OK = /^(\s*)not ok\b/;
// Passing tests and subtest headings carry the test's name, which may say "error".
const NOT_A_FAILURE = /^\s*(ok \d+|# Subtest:)/;
const STACK_KEY = /^(\s*)stack:/;

const bytes = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
const indentOf = (line: string): number => line.length - line.trimStart().length;
const clip = (line: string, max = MAX_LINE_LENGTH): string => (line.length > max ? `${line.slice(0, max)} …` : line);

/**
 * The lines that explain one TAP failure, starting at its `not ok` line: the
 * YAML diagnostics under it (error, expected, actual, the first lines of the
 * stack), up to the caps. Returns the block and the index after it.
 */
function tapBlock(lines: readonly string[], start: number): { block: string[]; next: number } {
  const indent = indentOf(lines[start] ?? '');
  const block = [clip(lines[start] ?? '')];
  let size = bytes(block);
  let cut = false;
  let stackIndent = -1;
  let stackKept = 0;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    const closing = line.trim() === '...';
    if (!cut) {
      const k = indentOf(line);
      let keep = true;
      if (stackIndent >= 0 && k > stackIndent) {
        keep = stackKept < STACK_LINES;
        stackKept++;
      } else {
        stackIndent = -1;
        const stack = STACK_KEY.exec(line);
        if (stack) {
          stackIndent = (stack[1] ?? '').length;
          stackKept = 0;
        }
      }
      if (keep) {
        const shown = clip(line);
        if (block.length >= MAX_FAILURE_LINES || size + Buffer.byteLength(shown) + 1 > MAX_FAILURE_BYTES) {
          block.push(`${' '.repeat(indent + 2)}… (cut)`);
          cut = true;
        } else {
          block.push(shown);
          size += Buffer.byteLength(shown) + 1;
        }
      }
    }
    if (closing) {
      i++;
      break;
    }
  }
  return { block, next: i };
}

/** The failures in `lines[0..end)`: each a block of lines, in log order. */
function failureBlocks(lines: readonly string[], end: number): string[][] {
  const blocks: string[][] = [];
  for (let i = 0; i < end; ) {
    const line = lines[i] ?? '';
    if (NOT_A_FAILURE.test(line) || !looksLikeFailure(line)) {
      i++;
    } else if (TAP_NOT_OK.test(line)) {
      const { block, next } = tapBlock(lines, i);
      blocks.push(block);
      i = next;
    } else {
      blocks.push([clip(line)]);
      i++;
    }
  }
  return blocks;
}

/**
 * A job log cut to `maxBytes`: the failures from before the tail (a TAP
 * failure with its diagnostics, any other failure-looking line alone), then
 * the last `tailLines` lines. GitHub's timestamps are stripped. A log with no
 * failure before the tail is just the tail. The tail has priority, but keeps
 * at most all of the budget the failures leave unused, and at least half of
 * it. A failure that does not fit is dropped whole and the excerpt says so.
 */
export function logExcerpt(log: string, options: { maxBytes: number; tailLines?: number }): string {
  const lines = plainLines(log.replace(TIMESTAMP, '').trimEnd());
  const tailStart = Math.max(0, lines.length - (options.tailLines ?? TAIL_LINES));
  const blocks = failureBlocks(lines, tailStart);
  const headings = 200;

  const failureBytes = blocks.reduce((sum, block) => sum + bytes(block), 0);
  const tailBudget = blocks.length === 0 ? options.maxBytes : options.maxBytes - Math.min(failureBytes + headings, Math.floor(options.maxBytes / 2));
  let tail = lines.slice(tailStart).map((line) => clip(line));
  while (tail.length > 1 && bytes(tail) > tailBudget) tail = tail.slice(1);

  if (blocks.length === 0) return tail.join('\n');

  let room = options.maxBytes - bytes(tail) - headings;
  const shown: string[][] = [];
  for (const block of blocks) {
    if (bytes(block) <= room) {
      shown.push(block);
      room -= bytes(block);
    }
  }
  const dropped = blocks.length - shown.length;
  return [
    ...(shown.length > 0 ? [`--- failure lines before the tail (${shown.length} of ${blocks.length}) ---`, ...shown.flat()] : []),
    ...(dropped > 0 ? [`_${dropped} failure${dropped === 1 ? '' : 's'} before the tail ${dropped === 1 ? 'was' : 'were'} dropped to fit the size limit; see the job log for ${dropped === 1 ? 'it' : 'them'}_`] : []),
    `--- last ${tail.length} lines ---`,
    ...tail,
  ].join('\n');
}
