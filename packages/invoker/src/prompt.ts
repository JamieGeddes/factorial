import type { WorkItem } from '@factorial/workitem';

/** The user message that starts the agent's session. The system prompt lives on the harness. */
export function buildPrompt(workItem: WorkItem, branch: string, baseBranch: string): string {
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
    '---',
    'The repository is cloned at /workspace/repo and checked out on the branch above. The full work item is at /workspace/workitem.json.',
    'Commit on this branch as you go, after each coherent step: if the session ends early, only committed work is kept.',
    'When you have finished, make sure everything is committed and write /workspace/summary.md as described in your instructions.',
  ].join('\n');
}
