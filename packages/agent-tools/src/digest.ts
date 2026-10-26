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

const FAILURE = /\b(not ok|fail(ed|ure|ing)?|errors?|exception|panic|cannot|unable)\b|✖|✗|ERR!/i;
// Error class names such as AssertionError or TypeError.
const ERROR_CLASS = /[a-z](Error|Exception)\b/;
// Summary lines that mention failure but report none, such as "# fail 0".
const NOT_A_FAILURE = /^\s*#?\s*(fail|failed|failures|errors?)\s*:?\s*0\s*$|\b0 (failed|failures|errors)\b/i;

export function looksLikeFailure(line: string): boolean {
  return (FAILURE.test(line) || ERROR_CLASS.test(line)) && !NOT_A_FAILURE.test(line);
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
