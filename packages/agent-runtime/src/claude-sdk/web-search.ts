/**
 * The web search tool (../web-search.ts) as an in-process MCP server for the
 * Claude Agent SDK.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { MAX_RESULTS_DESCRIPTION, QUERY_DESCRIPTION, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_TOOL, search, type GatewayCall } from '../web-search.ts';

/** The name the model sees: mcp__<server>__<tool>. */
export const SERVER_NAME = 'factorial';
export const TOOL_NAME = `mcp__${SERVER_NAME}__${WEB_SEARCH_TOOL}`;

export function webSearchServer(call: GatewayCall): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '0.1.0',
    tools: [
      tool(
        WEB_SEARCH_TOOL,
        WEB_SEARCH_DESCRIPTION,
        {
          query: z.string().min(1).max(200).describe(QUERY_DESCRIPTION),
          maxResults: z.number().int().min(1).max(25).optional().describe(MAX_RESULTS_DESCRIPTION),
        },
        (args) => search(call, args),
        { annotations: { readOnlyHint: true, openWorldHint: true } },
      ),
    ],
  });
}
