/** Strip anything that looks like a GitHub credential before text is logged, shown or stored. */
export function redactSecrets(text: string): string {
  return text
    .replace(/x-access-token:[^@\s'"]+@/g, 'x-access-token:***@')
    .replace(/\b(gh[pousr]|ghs|github_pat)_[A-Za-z0-9._-]+/g, '$1_***')
    .replace(/AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***');
}
