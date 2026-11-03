/**
 * A token starts where no word character comes before it, straight after a
 * JSON string escape, or straight after an ANSI colour sequence. Once text is
 * JSON-encoded, a newline before a token becomes `\n`, whose last character
 * is a letter, and a colour sequence such as `ESC[0m` ends in a letter even
 * in raw text, so a plain word boundary would match neither.
 */
const TOKEN =
  /(?:(?<![A-Za-z0-9_])|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=(?:\x1b|\\u001[bB])\[[0-9;]*[A-Za-z]))(gh[pousr]|ghs|github_pat)_[A-Za-z0-9._-]+/g;

/**
 * Credentials a session can hold besides GitHub's: the npm mirror's token in
 * an .npmrc line, and the execution role's temporary AWS credentials (an
 * access key id, and the secret key and session token as an environment
 * variable, a CLI config line or the credentials endpoint's JSON). Untrusted
 * code in a session (a verifier's check, a build's postinstall) can print
 * them, and its output is stored.
 */
const NPM_AUTH_TOKEN = /(:_authToken\s*=\s*)[^\s'"\\]+/g;
const AWS_ACCESS_KEY_ID = /(?<![A-Z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g;
const AWS_SECRET_ASSIGNMENT = /((?:aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{16,}/g;
const AWS_SECRET_JSON = /((?:\\?")(?:SecretAccessKey|SessionToken|Token)(?:\\?")\s*:\s*(?:\\?"))[A-Za-z0-9/+=]{16,}/g;

/** Strip anything that looks like a GitHub, npm mirror or AWS credential before text is logged, shown or stored. */
export function redactSecrets(text: string): string {
  return text
    .replace(/x-access-token:[^@\s'"]+@/g, 'x-access-token:***@')
    .replace(TOKEN, '$1_***')
    .replace(/AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***')
    .replace(NPM_AUTH_TOKEN, '$1***')
    .replace(AWS_ACCESS_KEY_ID, '$1****************')
    .replace(AWS_SECRET_ASSIGNMENT, '$1***')
    .replace(AWS_SECRET_JSON, '$1***');
}
