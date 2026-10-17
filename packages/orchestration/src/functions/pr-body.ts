import type { WorkContext } from '../lib/context.ts';

export interface TestResult {
  runUrl?: string;
  outcome?: string;
}

/** The pull request description: the agent's summary, then the evidence. */
export function pullRequestBody(ctx: WorkContext, summary: string, test: TestResult, headSha: string): string {
  const summaryText = summary.trim() || '_The agent did not write a summary._';
  const rows: Array<[string, string]> = [
    ['Work item', `[${ctx.workItem.source.type} ${ctx.workItem.source.id}](${ctx.workItem.source.url})`],
    ['Requested by', `@${ctx.workItem.requestedBy}`],
    ['Tests', test.runUrl ? `[${test.outcome ?? 'run'}](${test.runUrl})` : 'not run'],
    ['Head', `\`${headSha.slice(0, 12)}\``],
    ['Built by', `Factorial \`${ctx.factorialVersion.slice(0, 12)}\``],
    ['Session', `\`${ctx.sessionId}\``],
  ];
  const table = ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  return `${summaryText}\n\n---\n\n${table}\n`;
}
