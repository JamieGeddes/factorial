/**
 * The builder's report, checked before its run may end. The prompt asks for a
 * `## Plan steps` section in /workspace/summary.md with a line per step of
 * /workspace/plan.json; on the first Runtime item the model wrote a one-line
 * summary without reading the plan. The host's stop check sends it back,
 * at most MAX_REPORT_CHECKS times, until the section names every step.
 *
 * The plan is checked too. Since phase 3.1 the builder writes
 * /workspace/plan.json itself, from the plan subagent's reply: the plan check
 * validates it against the plan contract after every write or edit to it and
 * sends the errors back, and the stop check will not let the run end without
 * a valid plan. After MAX_PLAN_REJECTIONS invalid plans the gate closes:
 * every further tool call is denied (roles.ts) and the run may end,
 * as a finished run, so Collect reports it as invalid-plan. Collect validates
 * the plan again and is the gate; these only spare a build from an unusable
 * plan.
 *
 * The report stays the model's claim: this only makes it present. The host is
 * root and the files are the agent's, so they are opened without following a
 * link, must be regular files, and are read up to a cap. Nothing read from
 * them reaches the model except the plan, which the model wrote or could read
 * itself: its step ids, its validation errors, and its steps in full at the
 * start of a later round (planBrief).
 *
 * The checks return what to send the model, or undefined; the harness turns
 * that into its own hook result (pi/harness.ts, its host extension).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { parsePlanJson } from '@factorial/plan';

export const MAX_REPORT_CHECKS = 2;
/** Invalid plans written before the gate closes: the first is sent back to fix, the second ends the build. */
export const MAX_PLAN_REJECTIONS = 2;
/** Validation errors sent back, each cut to ERROR_CHARS, as Collect cuts them. */
const MAX_ERRORS = 10;
const ERROR_CHARS = 300;
const MAX_FILE_BYTES = 256 * 1024;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A regular file's text, or undefined if it is missing, a link or anything else. */
export function readAgentFile(file: string, maxBytes = MAX_FILE_BYTES): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO cannot hold the open; fstat then refuses it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The plan's step ids, or undefined if the plan cannot be read as one. */
export function planStepIds(planJson: string | undefined): string[] | undefined {
  if (planJson === undefined) return undefined;
  try {
    const steps = (JSON.parse(planJson) as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return undefined;
    const ids = steps.map((step: unknown) => (step as { id?: unknown } | null)?.id);
    return ids.every((id): id is string => typeof id === 'string' && STEP_ID.test(id)) ? ids : undefined;
  } catch {
    return undefined;
  }
}

interface PlanStep {
  id: string;
  description: string;
  files: string[];
  verification: string;
}

function isPlanStep(step: unknown): step is PlanStep {
  const { id, description, files, verification } = (step ?? {}) as Partial<Record<keyof PlanStep, unknown>>;
  return (
    typeof id === 'string' &&
    STEP_ID.test(id) &&
    typeof description === 'string' &&
    typeof verification === 'string' &&
    Array.isArray(files) &&
    files.every((file) => typeof file === 'string')
  );
}

/**
 * The plan's steps, appended to the builder's first message. On #120's
 * resumed attempt the model read only the step ids, never the step, and
 * rewrote a commit the step said to keep. Undefined if the plan cannot be
 * read as one, and the model then reads /workspace/plan.json as before.
 */
export function planBrief(planJson: string | undefined): string | undefined {
  if (planJson === undefined) return undefined;
  let steps: unknown;
  try {
    steps = (JSON.parse(planJson) as { steps?: unknown }).steps;
  } catch {
    return undefined;
  }
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every(isPlanStep)) return undefined;
  return [
    "## The plan's steps",
    '',
    'Copied from /workspace/plan.json. Do each step as its description says, including any condition on whether to change or commit anything, and report each by its id in summary.md.',
    ...steps.flatMap((step, i) => [
      '',
      `### ${i + 1}. \`${step.id}\``,
      '',
      step.description.trim(),
      '',
      `Files: ${step.files.length ? step.files.map((file) => `\`${file}\``).join(', ') : 'none listed'}`,
      `Verification: ${step.verification.trim()}`,
    ]),
  ].join('\n');
}

/** What is wrong with the plan, or undefined if it is valid. */
export function planErrors(planJson: string | undefined): string[] | undefined {
  if (planJson === undefined) return ['/workspace/plan.json is missing'];
  const result = parsePlanJson(planJson);
  if (result.ok) return undefined;
  return result.errors.slice(0, MAX_ERRORS).map((e) => `plan.json ${e.length > ERROR_CHARS ? `${e.slice(0, ERROR_CHARS)}…` : e}`);
}

function planInstruction(errors: string[]): string {
  return [
    '/workspace/plan.json does not meet the plan contract. Fix each problem and write the file again, before changing anything else:',
    ...errors.map((e) => `- ${e}`),
  ].join('\n');
}

/** Closed once the plan has been invalid MAX_PLAN_REJECTIONS times; shared by the plan, tool and stop hooks. */
export interface PlanGate {
  closed: boolean;
}

export const PLAN_GATE_CLOSED = 'The plan was invalid twice, so nothing will be built and the orchestrator reports it. Make no more tool calls: end the session now with a one-line reply.';

/**
 * The plan check, after each file write or edit: validates plan.json when the
 * call changed it, and returns what to send back while it is invalid. Closes
 * the gate at MAX_PLAN_REJECTIONS.
 */
export function planCheck(workspace: string, gate: PlanGate, onRejected: (errors: string[], closed: boolean) => void): (target: string) => string | undefined {
  const file = path.join(workspace, 'plan.json');
  let rejections = 0;
  return (target) => {
    if (path.resolve(workspace, target) !== file) return undefined;
    const errors = planErrors(readAgentFile(file));
    if (errors === undefined) return undefined;
    rejections += 1;
    if (rejections >= MAX_PLAN_REJECTIONS) gate.closed = true;
    onRejected(errors, gate.closed);
    return gate.closed ? PLAN_GATE_CLOSED : planInstruction(errors);
  };
}

/** The lines of the summary's `## Plan steps` section, or undefined if it has none. */
function planStepsSection(summary: string): string[] | undefined {
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => /^##\s+Plan steps\s*$/i.test(line.trim()));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Whether a line reports the step: the id first, after any list marker, quoting or emphasis. */
function reportsStep(line: string, id: string): boolean {
  const text = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, '').replace(/^[`*_]+/, '');
  return text.startsWith(id) && !/[A-Za-z0-9._-]/.test(text.charAt(id.length));
}

/** What the report lacks, as an instruction to the model, or undefined if it is complete. */
export function reportProblem(summary: string | undefined, stepIds: string[] | undefined): string | undefined {
  if (summary === undefined || summary.trim() === '') {
    return 'Before you finish, write /workspace/summary.md as your instructions describe: with the headings your instructions name: Summary, Behaviour impact, Breaking changes, Uncertainties, Not tested and Plan steps.';
  }
  if (stepIds === undefined || stepIds.length === 0) return undefined;
  const section = planStepsSection(summary);
  if (section === undefined) {
    return `/workspace/summary.md has no "## Plan steps" section. Read /workspace/plan.json and add the section: one line per step, starting with its id (${stepIds.join(', ')}), in the form \`- <id>: done|skipped|changed: <why, when not done as planned>\`. Make sure the summary also has the \`## Summary\` and \`## Behaviour impact\` sections.`;
  }
  const missing = stepIds.filter((id) => !section.some((line) => reportsStep(line, id)));
  if (missing.length === 0) return undefined;
  return `The "## Plan steps" section of /workspace/summary.md has no line for ${missing.join(', ')}. Add one line per missing step in the form \`- <id>: done|skipped|changed: <why, when not done as planned>\`.`;
}

/** The stop check: what to send the builder back with while its plan is invalid or its report incomplete, at most MAX_REPORT_CHECKS times. */
export function reportStopCheck(workspace: string, gate: PlanGate, onBlocked: (reason: string) => void): () => string | undefined {
  let checks = 0;
  return () => {
    if (checks >= MAX_REPORT_CHECKS || gate.closed) return undefined;
    const planJson = readAgentFile(path.join(workspace, 'plan.json'));
    const errors = planErrors(planJson);
    const reason = errors ? planInstruction(errors) : reportProblem(readAgentFile(path.join(workspace, 'summary.md')), planStepIds(planJson));
    if (reason === undefined) return undefined;
    checks += 1;
    onBlocked(reason);
    return reason;
  };
}
