/**
 * The seed: what a session starts with (#166). Every context a session is
 * given — the request, the notes, the points of a rework, the plan, the
 * diff, a repository's own instructions — is owned by one provider, a
 * function from the seeding context to files for /workspace and sections
 * for the first message. A stage lists its providers in the order they
 * run; `assembleSeed` runs them and checks what they return, and
 * `writeSeed` is the one place that puts the files into the session, in
 * one hardened script before the workspace is handed over to the model.
 * Adding a context is a function and an entry in a list.
 *
 * The order of a list is fixed and every provider runs in turn, never in
 * parallel, so what a session is given is the same every time, and the
 * numbering of a rework's points holds across rounds and for the reviewer.
 * Anything from untrusted text is redacted by the provider that reads it;
 * the caps here are the last check, not the first.
 */
import type { GitHubClient } from '@factorial/github-app';
import type { WorkItem, WorkItemReviewDetail } from '@factorial/workitem';

import type { ReworkTurn } from './context.ts';
import type { Attempt } from './resume.ts';
import type { SensitiveChange } from './review-files.ts';
import { mustRun, type SessionRole, type SessionTarget } from './session.ts';
import { HARDENED_GIT_ENV, shellQuote } from './shell.ts';

/** A file placed directly under /workspace. */
export type SeedFile = {
  /** The file's name under /workspace: no directory, so no provider can write elsewhere. */
  path: string;
  /** The most bytes the file may hold. */
  cap: number;
} & (
  | {
      content: string;
      /** Cut the content to the cap instead of refusing it; for prose, never for JSON. */
      truncate?: boolean;
      /** Add the content to the end of an earlier provider's file of the same name. */
      append?: boolean;
    }
  | {
      /**
       * A shell command, run in /workspace/repo, whose output is the file,
       * cut to the cap. For what is made from the clone and is too large to
       * carry through the orchestrator, the diff.
       */
      command: string;
    }
);

/** A section of the first message. It reaches the invoker through the state and the task's container overrides. */
export interface SeedSection {
  id: string;
  text: string;
  /** The most characters the section may hold: overrides are capped at 8 KiB in total. */
  cap: number;
}

/** What a stage needs back from its providers beyond the files. */
export interface SeedData {
  /** The points of a rework, in the order the rework file numbers them. */
  reworkPoints?: WorkItemReviewDetail[];
}

export interface SeedPart {
  files?: SeedFile[];
  sections?: SeedSection[];
  data?: SeedData;
}

/** What a provider may draw on: the item, where the session stands, what the stage already read. */
export interface SeedContext {
  role: SessionRole;
  workItem: WorkItem;
  /** The branch head the session starts from. */
  baseCommit: string;
  /** The target's base branch: per-repository providers read from it, never from the branch under work. */
  baseBranch: string;
  /** Present when the item resumes an earlier attempt. */
  resumedFrom?: Attempt;
  /** Present for a turn on a pull request. */
  rework?: ReworkTurn;
  /** The build round: 1 for a new session, more for a continuation. */
  round: number;
  /** A continuation: the commit the work started from, and what the previous round left on the branch. */
  continuing?: { baseCommit: string; pushed: boolean; commitCount: number };
  /** The previous round's notes, from the artefact store. */
  previousNotes?: string;
  /** The stored plan, validated. */
  plan?: { json: string; markdown: string };
  /** The builder's summary. */
  summary?: string;
  /** The reviewer's flagged paths. */
  sensitive?: SensitiveChange[];
  /** Run a read-only script in the session's clone and return its output. */
  read: (script: string) => Promise<string>;
  /** A read-only GitHub client for the repository, made when a provider first needs it. */
  github: () => Promise<GitHubClient>;
}

export type SeedProvider = (context: SeedContext) => SeedPart | Promise<SeedPart>;

export interface Seed {
  files: SeedFile[];
  sections: SeedSection[];
  data: SeedData;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The text cut to at most `cap` bytes, whole characters only, ending with a note. */
export function cutToBytes(text: string, cap: number): string {
  if (Buffer.byteLength(text, 'utf8') <= cap) return text;
  const note = `\n\n_Cut at ${cap} bytes by the orchestrator._\n`;
  const room = Math.max(0, cap - Buffer.byteLength(note, 'utf8'));
  return `${Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/\uFFFD$/, '')}${note}`;
}

/**
 * Run the providers in order and collect what they return. A file that is
 * over its cap is cut when its provider allows that and refused otherwise; a
 * second file of the same name is refused unless it appends to the first.
 */
export async function assembleSeed(providers: readonly SeedProvider[], context: SeedContext): Promise<Seed> {
  const files = new Map<string, SeedFile>();
  const sections = new Map<string, SeedSection>();
  const data: SeedData = {};
  for (const provider of providers) {
    const part = await provider(context);
    for (const file of part.files ?? []) {
      if (!FILE_NAME.test(file.path)) throw new Error(`${provider.name}: ${JSON.stringify(file.path)} is not a file name under /workspace`);
      const earlier = files.get(file.path);
      if (earlier === undefined) {
        if ('content' in file && file.append) throw new Error(`${provider.name}: ${file.path} appends to a file no earlier provider seeded`);
        files.set(file.path, file);
      } else if ('content' in file && file.append && 'content' in earlier) {
        files.set(file.path, { ...earlier, content: earlier.content + file.content });
      } else {
        throw new Error(`${provider.name}: ${file.path} is already seeded`);
      }
    }
    for (const section of part.sections ?? []) {
      if (sections.has(section.id)) throw new Error(`${provider.name}: section ${section.id} is already seeded`);
      if (section.text.length > section.cap) throw new Error(`${provider.name}: section ${section.id} is over its ${section.cap}-character cap`);
      sections.set(section.id, section);
    }
    Object.assign(data, part.data);
  }
  const capped = [...files.values()].map((file): SeedFile => {
    if (!('content' in file) || Buffer.byteLength(file.content, 'utf8') <= file.cap) return file;
    if (!file.truncate) throw new Error(`${file.path} is over its ${file.cap}-byte cap`);
    return { ...file, content: cutToBytes(file.content, file.cap) };
  });
  return { files: capped, sections: [...sections.values()], data };
}

/** A section's text by id, if the seed has it. */
export const sectionText = (seed: Seed, id: string): string | undefined => seed.sections.find((s) => s.id === id)?.text;

const encode = (text: string): string => shellQuote(Buffer.from(text, 'utf8').toString('base64'));

/**
 * The script that places the seed's files: content is base64-encoded so no
 * file can break the script, a command's output is cut to its cap. It runs
 * as root in a session no agent has run in yet.
 */
export function seedScript(seed: Seed): string {
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    ...seed.files.flatMap((file): string[] => {
      const target = `/workspace/${file.path}`;
      if ('content' in file) return [`printf '%s' ${encode(file.content)} | base64 -d > ${target}`];
      return [
        `(cd /workspace/repo && ${file.command}) > ${target}`,
        `if [ "$(stat -c %s ${target})" -gt ${file.cap} ]; then truncate -s ${file.cap} ${target}; fi`,
      ];
    }),
  ].join('\n');
}

/** The one writer: put the seed's files into the session. Call it before the workspace is handed over to the model. */
export async function writeSeed(target: SessionTarget, seed: Seed): Promise<void> {
  await mustRun(target, seedScript(seed), 300);
}
