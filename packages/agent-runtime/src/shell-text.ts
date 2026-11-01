/**
 * Reading a shell command's text for the tool rules (tool-rules.ts,
 * builder-shell.ts): what is quoted, what is a heredoc body, and where output
 * goes. A reading of the text, not a shell parser: good enough to judge the
 * commands a model writes, never a sandbox.
 */

/** The command with quoted text emptied. */
export function unquoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** A heredoc opener, `<<E`, `<<-E`, `<<'E'`, `<<"E"` or `<<\E`, and not a here-string (`<<<`). */
const HEREDOC = /(?<!<)<<(?!<)-?\s*(?:'(\w+)'|"(\w+)"|\\(\w+)|(\w+))/g;

export interface Heredoc {
  /** Whether the delimiter is quoted, so the body is literal text the shell does not expand. */
  quoted: boolean;
  body: string;
}

/**
 * The command split into its shell text and its heredoc bodies, delimiter
 * lines removed with the bodies. A `<<` inside quotes is text, not a heredoc:
 * the quotes before it must balance. Must run on the raw command, before
 * unquoted() erases the delimiters' quotes.
 */
export function splitHeredocs(command: string): { shell: string; heredocs: Heredoc[] } {
  const kept: string[] = [];
  const heredocs: Heredoc[] = [];
  const pending: { delimiter: string; quoted: boolean }[] = [];
  let body: string[] = [];
  for (const line of command.split('\n')) {
    const current = pending[0];
    if (current) {
      if (line.trim() === current.delimiter) {
        heredocs.push({ quoted: current.quoted, body: body.join('\n') });
        body = [];
        pending.shift();
      } else {
        body.push(line);
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(HEREDOC)) {
      if (/['"]/.test(unquoted(line.slice(0, match.index)).replace(/''|""/g, ''))) continue;
      const unquotedDelimiter = match[4];
      pending.push({ delimiter: (match[1] ?? match[2] ?? match[3] ?? unquotedDelimiter)!, quoted: unquotedDelimiter === undefined });
    }
  }
  // An unterminated heredoc runs to the end of the command.
  if (pending.length > 0) heredocs.push({ quoted: pending[0]!.quoted, body: body.join('\n') });
  return { shell: kept.join('\n'), heredocs };
}

/** A heredoc whose delimiter is quoted, so its body is literal text: `<<'E'`, `<<"E"`, `<<\E`, `<<-'E'`. */
const QUOTED_HEREDOC = /(?<!<)<<-?\s*(?:'(\w+)'|"(\w+)"|\\(\w+))/;

/**
 * The command with the bodies of quoted heredocs removed, delimiter lines
 * included. A body is data (the review's text, which holds `>` and words
 * like `rm`), not shell, so it is not scanned. The body of a heredoc with an
 * unquoted delimiter is kept: the shell expands `$(...)` in it. Must run on
 * the raw command, before unquoted() erases the delimiter's quotes.
 */
export function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of command.split('\n')) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    const match = QUOTED_HEREDOC.exec(line);
    // A `<<` inside quotes is text, not a heredoc: the quotes before it must balance.
    if (match && !/['"]/.test(unquoted(line.slice(0, match.index)).replace(/''|""/g, ''))) {
      delimiter = match[1] ?? match[2] ?? match[3];
    }
  }
  return kept.join('\n');
}

export type Redirection = { operator: string; target: string };

/**
 * The output redirections in shell text that has had its quotes emptied,
 * leaving out those to /dev/null and between standard streams. A target that
 * is not a plain word is an empty string.
 */
export function redirectionsIn(text: string): Redirection[] {
  const harmless = text.replace(/\d*>>?\s*\/dev\/null\b/g, '').replace(/\d*>&\d\b/g, '');
  return [...harmless.matchAll(/(\d*|&)(>>?)\s*([^\s;&|<>()]*)/g)].map((match) => ({ operator: (match[1] ?? '') + (match[2] ?? ''), target: match[3] ?? '' }));
}

/** The output redirections in a command: quoted heredoc bodies, quoted text and harmless redirections are ignored. */
export function redirections(command: string): Redirection[] {
  return redirectionsIn(unquoted(withoutHeredocBodies(command)));
}
