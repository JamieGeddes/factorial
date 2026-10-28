/**
 * pi's tools: what it calls each kind (../tools.ts), its tool calls as the
 * rules see them, and the tool set for a list of kinds. Every tool that
 * touches the workspace or runs a command does it as the agent user
 * (operations.ts). pi's own grep is not used: it runs ripgrep as the host
 * process and downloads it if missing; `grep` here searches through the file
 * helper instead.
 */
import { Type } from '@earendil-works/pi-ai';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/** Any of pi's tool definitions, whatever its parameters and details. */
export type AnyTool = ToolDefinition<any, any, any>;

import type { ToolCall, ToolKind, ToolNames } from '../tools.ts';
import { MAX_RESULTS_DESCRIPTION, QUERY_DESCRIPTION, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_TOOL, search, type GatewayCall } from '../web-search.ts';
import type { AgentRunner } from './as-agent.ts';
import { bashOperations, editOperations, findOperations, grepFiles, readOperations, writeOperations, type Helper } from './operations.ts';

export const PI_TOOLS: ToolNames = {
  shell: 'bash',
  read: 'read',
  edit: 'edit',
  write: 'write',
  grep: 'grep',
  glob: 'find',
  fetch: 'web_fetch',
  agent: 'task',
  webSearch: WEB_SEARCH_TOOL,
};

export function toolCallOf(toolName: string, input: unknown): ToolCall {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const target = typeof fields.path === 'string' ? fields.path : undefined;
  if (toolName === PI_TOOLS.write) return { kind: 'write', path: target };
  if (toolName === PI_TOOLS.edit) return { kind: 'edit', path: target };
  if (toolName === PI_TOOLS.shell) return { kind: 'shell', command: typeof fields.command === 'string' ? fields.command : '' };
  return { kind: 'other', name: toolName };
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: undefined, ...(isError ? { isError: true } : {}) });

const GREP_LIMIT = 100;

export function grepTool(helper: Helper, cwd: string): AnyTool {
  return defineTool({
    name: PI_TOOLS.grep,
    label: 'grep',
    description: `Search file contents for a JavaScript regular expression. Returns matching lines as path:line: text, at most ${GREP_LIMIT} by default. Skips .git, node_modules and binary files.`,
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression to search for.' }),
      path: Type.Optional(Type.String({ description: 'File or directory to search; default the working directory.' })),
      glob: Type.Optional(Type.String({ description: 'Only files whose name or relative path matches this glob, e.g. *.ts.' })),
      ignoreCase: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ description: `Maximum matches; default ${GREP_LIMIT}.` })),
    }),
    async execute(_id, params) {
      try {
        new RegExp(params.pattern);
      } catch (error) {
        return text(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const root = params.path ? (params.path.startsWith('/') ? params.path : `${cwd}/${params.path}`) : cwd;
      try {
        const matches = await grepFiles(helper, root, params.pattern, { limit: params.limit ?? GREP_LIMIT, ignoreCase: params.ignoreCase ?? false, include: params.glob });
        if (matches.length === 0) return text('No matches.');
        return text(matches.map((m) => `${m.file.startsWith(`${cwd}/`) ? m.file.slice(cwd.length + 1) : m.file}:${m.line}: ${m.text}`).join('\n'));
      } catch (error) {
        return text(`grep failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
}

export function webSearchTool(call: GatewayCall): AnyTool {
  return defineTool({
    name: PI_TOOLS.webSearch,
    label: 'web search',
    description: WEB_SEARCH_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: QUERY_DESCRIPTION }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: MAX_RESULTS_DESCRIPTION })),
    }),
    async execute(_id, params) {
      const result = await search(call, params);
      return { content: result.content, details: undefined, ...(result.isError ? { isError: true } : {}) };
    },
  });
}

export interface ToolDeps {
  cwd: string;
  runner: AgentRunner;
  helper: Helper;
  /** Present when the gateway is configured and the role or subagent is offered search. */
  webSearch: GatewayCall | undefined;
  /** The fetch tool (fetch.ts), and the subagent tool for a role with subagents (subagents.ts). */
  fetch: AnyTool | undefined;
  agent: AnyTool | undefined;
}

/** The tools for these kinds, in order; a kind with nothing to offer (search with no gateway) is left out. */
export function toolsFor(kinds: readonly ToolKind[], deps: ToolDeps): AnyTool[] {
  const tools: AnyTool[] = [];
  for (const kind of kinds) {
    const tool = ((): AnyTool | undefined => {
      switch (kind) {
        case 'shell':
          return createBashToolDefinition(deps.cwd, { operations: bashOperations(deps.runner), exposeSessionEnvironment: false });
        case 'read':
          return createReadToolDefinition(deps.cwd, { operations: readOperations(deps.helper) });
        case 'edit':
          return createEditToolDefinition(deps.cwd, { operations: editOperations(deps.helper) });
        case 'write':
          return createWriteToolDefinition(deps.cwd, { operations: writeOperations(deps.helper) });
        case 'glob':
          return createFindToolDefinition(deps.cwd, { operations: findOperations(deps.helper) });
        case 'grep':
          return grepTool(deps.helper, deps.cwd);
        case 'webSearch':
          return deps.webSearch ? webSearchTool(deps.webSearch) : undefined;
        case 'fetch':
          return deps.fetch;
        case 'agent':
          return deps.agent;
      }
    })();
    if (tool) tools.push(tool);
  }
  return tools;
}
