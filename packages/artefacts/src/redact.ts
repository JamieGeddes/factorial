/**
 * A token starts where no word character comes before it, straight after a
 * JSON string escape, or straight after an ANSI colour sequence. Once text is
 * JSON-encoded, a newline before a token becomes `\n`, whose last character
 * is a letter, and a colour sequence such as `ESC[0m` ends in a letter even
 * in raw text, so a plain word boundary would match neither.
 */
const TOKEN =
  /(?:(?<![A-Za-z0-9_])|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=(?:\x1b|\\u001[bB])\[[0-9;]*[A-Za-z]))(gh[pousr]|ghs|github_pat)_[A-Za-z0-9._-]+/g;

/** Strip anything that looks like a GitHub credential before text is logged, shown or stored. */
export function redactSecrets(text: string): string {
  return text
    .replace(/x-access-token:[^@\s'"]+@/g, 'x-access-token:***@')
    .replace(TOKEN, '$1_***')
    .replace(/AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***');
}
