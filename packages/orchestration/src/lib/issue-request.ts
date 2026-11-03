/**
 * The request of a turn asked for in an issue's conversation (#169): the
 * issue's title and body as Intake read them when it admitted the turn,
 * stored once as `intake/request.json`. Every session seeded for the item
 * is seeded from this snapshot, never from the issue as it is later, so an
 * edit made after the turn was asked for (by anyone who can edit the
 * issue) cannot change what the agent works on. A labelled issue is the
 * same: its WorkItem carries the body as it was when it was labelled.
 */
import { getTextArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import type { IssueState } from '@factorial/github-app';

import type { SeedRequest } from './seed.ts';

export const ISSUE_REQUEST_ARTEFACT = 'intake/request.json';

/** The WorkItem's own caps on `title` and `body`. */
const MAX_TITLE = 256;
const MAX_BODY = 65_536;
/** Room for the JSON around a body at its cap. */
const MAX_ARTEFACT_BYTES = 4 * MAX_BODY;

/** The snapshot of an issue: what the agent is given as its task, redacted and capped. */
export function issueRequest(issue: Pick<IssueState, 'title' | 'body'>, url: string): SeedRequest {
  return { title: redactSecrets(issue.title).slice(0, MAX_TITLE), body: redactSecrets(issue.body).slice(0, MAX_BODY), url };
}

/** Read a stored snapshot back, or undefined when it is not there whole or not this shape. */
export function parseIssueRequest(text: string | undefined): SeedRequest | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { title, body, url } = value;
    if (typeof title !== 'string' || typeof body !== 'string' || typeof url !== 'string') return undefined;
    if (title.length > MAX_TITLE || body.length > MAX_BODY || !url.startsWith('https://github.com/')) return undefined;
    return { title, body, url };
  } catch {
    return undefined;
  }
}

export async function storeIssueRequest(prefix: string, request: SeedRequest): Promise<void> {
  await putJsonArtefact(prefix, ISSUE_REQUEST_ARTEFACT, request);
}

/** A turn on an issue whose snapshot is missing or unreadable: it is not seeded from anything else. */
export class IssueRequestMissingError extends Error {
  constructor(prefix: string) {
    super(`no readable ${ISSUE_REQUEST_ARTEFACT} under ${prefix}; the turn is not seeded from the issue as it is now`);
    this.name = 'IssueRequestMissing';
  }
}

export async function loadIssueRequest(prefix: string): Promise<SeedRequest> {
  const read = await getTextArtefact(prefix, ISSUE_REQUEST_ARTEFACT, MAX_ARTEFACT_BYTES);
  const request = read?.truncated ? undefined : parseIssueRequest(read?.text);
  if (!request) throw new IssueRequestMissingError(prefix);
  return request;
}
