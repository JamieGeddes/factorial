/**
 * The Claude Agent SDK's tools: what it calls each kind (../tools.ts), and its
 * tool calls as the rules see them.
 */
import type { ToolCall, ToolNames } from '../tools.ts';
import { TOOL_NAME } from './web-search.ts';

export const CLAUDE_TOOLS: ToolNames = {
  shell: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  fetch: 'WebFetch',
  agent: 'Agent',
  webSearch: TOOL_NAME,
};

/** The SDK's file tools, their kind and the input field that names their target. */
const FILE_TOOLS: Record<string, { kind: 'write' | 'edit' | 'notebook'; field: string }> = {
  Write: { kind: 'write', field: 'file_path' },
  Edit: { kind: 'edit', field: 'file_path' },
  NotebookEdit: { kind: 'notebook', field: 'notebook_path' },
};

export function toolCallOf(toolName: string, input: unknown): ToolCall {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const file = FILE_TOOLS[toolName];
  if (file) {
    const target = fields[file.field];
    return { kind: file.kind, path: typeof target === 'string' ? target : undefined };
  }
  if (toolName === CLAUDE_TOOLS.shell) return { kind: 'shell', command: typeof fields.command === 'string' ? fields.command : '' };
  return { kind: 'other', name: toolName };
}
