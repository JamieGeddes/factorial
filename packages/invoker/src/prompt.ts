import type { WorkItem } from '@factorial/workitem';

/** The rework instructions added to the prompt when the item carries rework context. */
export function reworkInstructions(): string[] {
  return [
    'This is rework of an existing pull request: the repository already contains the earlier work, on the branch above.',
    'Read /workspace/rework.md: it lists every point that must be addressed.',
    'Address each point, building on the existing work on the branch rather than starting over.',
    'In /workspace/summary.md, say how each of the points in /workspace/rework.md was handled.',
  ];
}

/** The user message that starts the agent's session. The system prompt lives on the harness. */
export function buildPrompt(workItem: WorkItem, branch: string, baseBranch: string): string {
  const isRework = workItem.context?.kind === 'rework';
  return [
    `# Work item ${workItem.source.id} (${workItem.source.type})`,
    '',
    `Source: ${workItem.source.url}`,
    `Repository: ${workItem.repository.owner}/${workItem.repository.name}`,
    `Branch: ${branch} (based on ${baseBranch})`,
    `Requested by: ${workItem.requestedBy}`,
    '',
    `## ${workItem.title}`,
    '',
    workItem.body.trim() || '_No further description was given._',
    '',
    ...(isRework ? ['', ...reworkInstructions()] : []),
    '',
    '---',
    'The repository is cloned at /workspace/repo and checked out on the branch above. The full work item is at /workspace/workitem.json.',
    'Commit on this branch as you go, after each coherent step: if the session ends early, only committed work is kept.',
    `Older messages, including this one, are dropped as the session grows. /workspace/notes.md already starts with this request under "# Task": keep that section, add your notes below it, and re-read it${isRework ? ' and /workspace/rework.md' : ''} rather than relying on memory.`,
    'Before changing any code, re-read the Task section and write your plan under "# Plan" in /workspace/notes.md: each requirement, and the change that meets it. Re-read the Task section before each commit and before writing the summary, and check the work against it.',
    'When you have finished, make sure everything is committed and write /workspace/summary.md as described in your instructions.',
  ].join('\n');
}
