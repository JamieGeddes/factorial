/**
 * Tools by what they do, not by what a harness calls them. A role names the
 * kinds it is offered (roles.ts) and its prompts take each harness's names
 * (prompts/), and the rules judge a ToolCall (tool-rules.ts), so a role is
 * defined once for every harness. Each harness maps its own tools to these:
 * pi/tools.ts for pi.
 */

/** The tools a role may be offered. */
export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'fetch' | 'agent' | 'webSearch' | 'awsDocs';

/**
 * The kinds offered through a gateway: web search (one tool) and AWS
 * documentation (three, aws-docs.ts). Each is offered only when the Runtime
 * version names its gateway's URL. A role definition lists them in one place
 * (HostRole.gatewayTools, roles.ts).
 */
export type GatewayToolSet = Extract<ToolKind, 'webSearch' | 'awsDocs'>;

/**
 * What a harness calls each kind, as the model sees it. For `awsDocs`, which
 * stands for several tools, the prefix of their names.
 */
export type ToolNames = Readonly<Record<ToolKind, string>>;

/**
 * One tool call, as the rules see it. `write` creates or replaces a file
 * and `edit` changes part of one: the file tools the rules confine. `path` is as the model gave it, undefined when it gave
 * none. Anything else is `other`, which the rules allow.
 */
export type ToolCall =
  | { kind: 'shell'; command: string }
  | { kind: 'write' | 'edit'; path: string | undefined }
  | { kind: 'other'; name: string };
