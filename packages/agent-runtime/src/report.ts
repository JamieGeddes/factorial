/**
 * The builder's report, checked before its run may end. The prompt asks for a
 * `## Plan steps` section in /workspace/summary.md with a line per step of
 * /workspace/plan.json; on the first Runtime item the model wrote a one-line
 * summary without reading the plan. A Stop hook in the host sends it back,
 * at most MAX_REPORT_CHECKS times, until the section names every step.
 *
 * The report stays the model's claim: this only makes it present. The host is
 * root and the files are the agent's, so they are opened without following a
 * link, must be regular files, and are read up to a cap. Nothing read from
 * them reaches the model except the plan: its step ids here, and its steps in
 * full at the start of the run (planBrief), which the model could read itself.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export const MAX_REPORT_CHECKS = 2;
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

/** The Stop hook: send the builder back while its report is incomplete, at most MAX_REPORT_CHECKS times. */
export function stopHooks(workspace: string, onBlocked: (reason: string) => void): HookCallbackMatcher[] {
  let checks = 0;
  return [
    {
      hooks: [
        async (input: HookInput): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name !== 'Stop' || checks >= MAX_REPORT_CHECKS) return {};
          const reason = reportProblem(
            readAgentFile(path.join(workspace, 'summary.md')),
            planStepIds(readAgentFile(path.join(workspace, 'plan.json'))),
          );
          if (reason === undefined) return {};
          checks += 1;
          onBlocked(reason);
          return { decision: 'block', reason };
        },
      ],
    },
  ];
}
