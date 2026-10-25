/**
 * The builder's summary.md, read as fixed sections. The prompt asks for these
 * headings and a word limit for each; the orchestrator places each section in
 * its slot of the pull request and caps its length, whatever the builder
 * wrote. Nothing here interprets prose: a step's status is read only from the
 * fixed position the prompt names (`- <id>: done|skipped|changed: <note>`).
 */

export const SUMMARY_HEADINGS = {
  summary: '## Summary',
  behaviour: '## Behaviour impact',
  breaking: '## Breaking changes',
  uncertainties: '## Uncertainties',
  notTested: '## Not tested',
  planSteps: '## Plan steps',
} as const;

/** Character caps applied when rendering, a little above the word limits in the prompt. */
export const SUMMARY_CAPS = {
  summary: 800,
  behaviour: 600,
  breaking: 600,
  uncertaintyBullets: 5,
  uncertainty: 200,
  notTestedBullets: 3,
  stepNote: 300,
} as const;

export type StepStatus = 'done' | 'skipped' | 'changed';

export interface StepReport {
  /** The plan step id the line starts with, or undefined for a line that does not parse. */
  id?: string;
  status?: StepStatus;
  note: string;
  /** The line as written, for lines that did not parse. */
  raw: string;
}

export interface BuilderSummary {
  summary?: string;
  behaviour?: string;
  breaking?: string;
  uncertainties: string[];
  /** Undefined when the section is absent, so "not reported" differs from "nothing". */
  notTested?: string[];
  steps: StepReport[];
}

/** Dashes read as an AI tell and are banned from the body: map them to a hyphen. */
export const replaceEmDashes = (text: string): string => text.replace(/[—–]/g, '-');

/** Cut to at most `max` characters, ending in an ellipsis when cut. */
export function cutText(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const STEP_LINE = /^(?:[-*+]|\d+[.)])?\s*[`*_]*([A-Za-z0-9][A-Za-z0-9._-]{0,63}?)[`*_]*\s*:\s*(done|skipped|changed)\b\s*[:\-.]?\s*(.*)$/i;

export function parseStepLine(line: string): StepReport {
  const raw = line.trim();
  const match = STEP_LINE.exec(raw);
  if (!match) return { note: raw, raw };
  return { id: match[1]!, status: match[2]!.toLowerCase() as StepStatus, note: match[3]!.trim(), raw };
}

const bulletText = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();

/** The sections of a summary, or undefined when it has none of the fixed headings (a free-form summary). */
export function parseBuilderSummary(text: string): BuilderSummary | undefined {
  const names = new Map(Object.entries(SUMMARY_HEADINGS).map(([key, heading]) => [heading.toLowerCase(), key]));
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    const key = names.get(line.trim().toLowerCase());
    if (key !== undefined) {
      current = [];
      if (!sections.has(key)) sections.set(key, current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) current = undefined;
    else current?.push(line);
  }
  if (sections.size === 0) return undefined;
  const body = (key: string): string | undefined => {
    const value = sections.get(key)?.join('\n').trim();
    return value ? value : undefined;
  };
  const lines = (key: string): string[] => (sections.get(key) ?? []).map((l) => l.trim()).filter(Boolean);
  const noneWord = /^(none|n\/a|nothing)\.?$/i;
  return {
    ...(body('summary') !== undefined ? { summary: body('summary')! } : {}),
    ...(body('behaviour') !== undefined ? { behaviour: body('behaviour')! } : {}),
    ...(body('breaking') !== undefined ? { breaking: body('breaking')! } : {}),
    uncertainties: lines('uncertainties').map(bulletText).filter((l) => l && !noneWord.test(l)),
    ...(sections.has('notTested') ? { notTested: lines('notTested').map(bulletText).filter((l) => l && !noneWord.test(l)) } : {}),
    steps: lines('planSteps').map(parseStepLine),
  };
}
