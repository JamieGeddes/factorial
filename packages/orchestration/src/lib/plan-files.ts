/**
 * Reading the plan out of the builder's session. The builder writes
 * /workspace/plan.md and /workspace/plan.json from its plan subagent, and the
 * session is hostile once the model has run, so only those two files are
 * read: regular files only (never symlinks), capped in size by the read
 * itself, redacted, and the JSON validated against the plan contract. What
 * is stored, and seeded into a later round, is exactly what was validated.
 */
import { redactSecrets } from '@factorial/artefacts';
import { parsePlanJson, type Plan } from '@factorial/plan';

import { shellQuote } from './shell.ts';

export const MAX_PLAN_FILE_BYTES = 64 * 1024;
const SECTION = '\n===FACTORIAL-PLAN===\n';
const FILES = ['plan.md', 'plan.json'] as const;
/** At most this many validation errors are kept, each cut to ERROR_CHARS (the host's plan hook cuts the same). */
const MAX_ERRORS = 10;
const ERROR_CHARS = 300;

/**
 * Print each plan file as `ok:<size>:<base64>` (the first MAX + 1 bytes, so
 * an oversized file is detectable), or `missing:`.
 */
export function readPlanScript(): string {
  const lines = ['set -uo pipefail'];
  FILES.forEach((file, i) => {
    if (i > 0) lines.push(`printf '%s' ${shellQuote(SECTION)}`);
    const path = shellQuote(`/workspace/${file}`);
    lines.push(
      `if [ -f ${path} ] && [ ! -L ${path} ]; then printf 'ok:%s:' "$(stat -c %s -- ${path})"; head -c ${MAX_PLAN_FILE_BYTES + 1} -- ${path} | base64 -w0; else printf 'missing:'; fi`,
    );
  });
  lines.push('exit 0');
  return lines.join('\n');
}

export interface RawPlanFiles {
  markdown?: { text: string; size: number } | undefined;
  json?: { text: string; size: number } | undefined;
}

/**
 * The size the session reported, or the bytes actually received if more. The
 * session is hostile and its `stat` or `head` could lie, so the cap is
 * enforced on what arrived as well.
 */
export function parsePlanRead(stdout: string): RawPlanFiles {
  const sections = stdout.split(SECTION);
  if (sections.length !== FILES.length) throw new Error(`expected ${FILES.length} plan files from the session, got ${sections.length}`);
  const [markdown, json] = sections.map((section) => {
    if (section.startsWith('missing:')) return undefined;
    const match = /^ok:([0-9]{1,12}):([A-Za-z0-9+/=]*)\s*$/.exec(section);
    if (!match) throw new Error('plan export did not produce base64 output');
    const base64 = match[2] ?? '';
    // Base64 of MAX + 1 bytes; anything longer is over the cap before decoding.
    if (base64.length > Math.ceil((MAX_PLAN_FILE_BYTES + 1) / 3) * 4) return { text: '', size: Number.MAX_SAFE_INTEGER };
    const content = Buffer.from(base64, 'base64');
    return { text: content.toString('utf8'), size: Math.max(Number(match[1]), content.length) };
  });
  return { markdown, json };
}

export type CheckedPlan =
  | { ok: true; plan: Plan; markdown: string; json: string }
  | { ok: false; errors: string[]; markdown?: string | undefined; json?: string | undefined };

function cut(errors: string[]): string[] {
  return errors.slice(0, MAX_ERRORS).map((e) => (e.length > ERROR_CHARS ? `${e.slice(0, ERROR_CHARS)}…` : e));
}

/**
 * Check what was read: both files present, within the cap, plan.md not
 * empty, and plan.json valid. Text is redacted before it is validated, so
 * the stored and seeded copies are the validated ones.
 */
export function checkPlanFiles(files: RawPlanFiles): CheckedPlan {
  const errors: string[] = [];
  const markdown = files.markdown ? redactSecrets(files.markdown.text) : undefined;
  const json = files.json ? redactSecrets(files.json.text) : undefined;
  if (!files.markdown) errors.push('/workspace/plan.md is missing');
  else if (files.markdown.size > MAX_PLAN_FILE_BYTES) errors.push(`/workspace/plan.md is ${files.markdown.size} bytes, over the ${MAX_PLAN_FILE_BYTES}-byte limit`);
  else if (!markdown?.trim()) errors.push('/workspace/plan.md is empty');
  if (!files.json) errors.push('/workspace/plan.json is missing');
  else if (files.json.size > MAX_PLAN_FILE_BYTES) errors.push(`/workspace/plan.json is ${files.json.size} bytes, over the ${MAX_PLAN_FILE_BYTES}-byte limit`);
  if (errors.length > 0 || json === undefined || markdown === undefined) return { ok: false, errors: cut(errors), markdown, json };
  const result = parsePlanJson(json);
  if (!result.ok) return { ok: false, errors: cut(result.errors.map((e) => `plan.json ${e}`)), markdown, json };
  return { ok: true, plan: result.value, markdown, json };
}

/** The plan was missing or invalid when the build ended: reported to the requester, with nothing pushed. */
export class InvalidPlanError extends Error {
  constructor(errors: readonly string[]) {
    super(`The builder did not produce a valid plan:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'InvalidPlan';
  }
}

/** The plan as the state machine carries it to the pull request: small, whatever the plan's size. */
export interface PlanDigest {
  summary: string;
  steps: Array<{ id: string; description: string }>;
  /** Work the planner left for a later item, each cut to 200 characters. */
  followUp?: string[];
}

export function planDigest(plan: Plan): PlanDigest {
  const firstLine = (text: string): string => {
    const line = text.trim().split('\n')[0] ?? '';
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  };
  return {
    summary: plan.summary,
    steps: plan.steps.map((step) => ({ id: step.id, description: firstLine(step.description) })),
    ...(plan.followUp?.length ? { followUp: plan.followUp.map(firstLine) } : {}),
  };
}
