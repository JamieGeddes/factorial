/**
 * The short report `quiet` prints in place of a command's full output. Every
 * line the agent reads is resent on each later model call, so the report keeps
 * only what decides the next step: the exit code, where the full log is, the
 * lines that look like failures and the end of the output.
 */

export interface DigestOptions {
  /** Lines from the end of the output to show when the command failed. */
  tailOnFailure: number;
  /** Lines from the end of the output to show when the command succeeded. */
  tailOnSuccess: number;
  /** Most failure-looking lines to show from before the tail. */
  maxMatches: number;
  /** Longest line shown; longer lines are cut. */
  maxLineLength: number;
}

export const DEFAULT_OPTIONS: DigestOptions = {
  tailOnFailure: 30,
  tailOnSuccess: 5,
  maxMatches: 40,
  maxLineLength: 300,
};

// Failure words in any toolchain's output, then lines that carry the detail
// without one: pytest's assertion lines ("E   assert 1 == 2") and Go's test
// messages ("foo_test.go:12: got 1, want 2").
const FAILURE = /\b(not ok|fail(ed|ures?|ing)?|errors?|exception|panic(ked)?|fatal|traceback|cannot|unable)\b|✖|✗|ERR!/i;
const DETAIL = /^E {3}|_test\.go:\d+:/;
// Error class names such as AssertionError or TypeError.
const ERROR_CLASS = /[a-z](Error|Exception)\b/;
// Counts of none, such as "# fail 0", "0 failed" or "Failures: 0, Errors: 0",
// removed before matching so a summary that reports no failure is not one.
const ZERO_COUNT = /\b((fail(ed|ures?)?|errors?)\s*[:=]?\s*0|0\s+(fail(ed|ures?)?|errors?))\b/gi;

export function looksLikeFailure(line: string): boolean {
  const counted = line.replace(ZERO_COUNT, '');
  return FAILURE.test(counted) || ERROR_CLASS.test(counted) || DETAIL.test(line);
}

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)} …` : line;
}

export function digest(params: {
  command: string;
  exitCode: number;
  output: string;
  logPath: string;
  options?: DigestOptions;
}): string {
  const options = params.options ?? DEFAULT_OPTIONS;
  const lines = params.output.replace(/\n$/, '').split('\n');
  const total = params.output === '' ? 0 : lines.length;
  const failed = params.exitCode !== 0;
  const tailSize = Math.min(total, failed ? options.tailOnFailure : options.tailOnSuccess);
  const tailStart = total - tailSize;

  const report = [
    `$ ${params.command}`,
    `exit ${params.exitCode} · ${total} lines · full output: ${params.logPath}`,
  ];

  if (failed) {
    const matches = lines.slice(0, tailStart).filter(looksLikeFailure);
    if (matches.length > 0) {
      const shown = matches.slice(0, options.maxMatches);
      report.push(`--- failure lines before the tail (${shown.length} of ${matches.length}) ---`);
      report.push(...shown.map((line) => clip(line, options.maxLineLength)));
    }
  }
  if (tailSize > 0) {
    report.push(`--- last ${tailSize} lines ---`);
    report.push(...lines.slice(tailStart).map((line) => clip(line, options.maxLineLength)));
  }
  return `${report.join('\n')}\n`;
}

/** A file-name-safe slug of the command, for the log file name. */
export function slug(command: string): string {
  return (
    command
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'command'
  );
}
