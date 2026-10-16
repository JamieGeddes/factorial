/** The key=value lines git sends to a credential helper on stdin. */
export type GitCredentialRequest = Record<string, string>;

export function parseGitCredentialInput(input: string): GitCredentialRequest {
  const request: GitCredentialRequest = {};
  for (const line of input.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      request[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return request;
}

/** Only answer for HTTPS requests to github.com; stay silent for anything else. */
export function shouldAnswer(request: GitCredentialRequest): boolean {
  return request.protocol === 'https' && request.host === 'github.com';
}
