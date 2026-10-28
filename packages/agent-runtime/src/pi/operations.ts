/**
 * pi's tool operations, run as the agent user (as-agent.ts). pi calls these
 * instead of its local defaults, so its tools keep their own behaviour (edit
 * matching, truncation, output files) while every command and file access
 * happens with the agent's privileges. pi's own environment for a command is
 * ignored: the runner's is the only one the agent sees.
 */
import type { BashOperations, EditOperations, FindOperations, GrepOperations, ReadOperations, WriteOperations } from '@earendil-works/pi-coding-agent';

import { runAsAgent, type AgentRunner } from './as-agent.ts';

/** How to start the file helper: node and the helper's path (agent-ops.mjs beside the host bundle). */
export interface Helper {
  runner: AgentRunner;
  /** e.g. ['node', '--no-warnings', '/opt/factorial/agent-runtime/agent-ops.mjs'] */
  command: readonly string[];
  cwd: string;
}

async function op(helper: Helper, args: string[], input?: string | Buffer): Promise<Buffer> {
  const result = await runAsAgent(helper.runner, [...helper.command, ...args], { cwd: helper.cwd, ...(input === undefined ? {} : { input }) });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${args[0]} failed`);
  return result.stdout;
}

const json = async <T>(helper: Helper, args: string[]): Promise<T> => JSON.parse((await op(helper, args)).toString('utf8')) as T;

/** A command's time limit when the model sets none: the SDK host's BASH_DEFAULT_TIMEOUT_MS, for installs and checks. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;

export function bashOperations(runner: AgentRunner): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const timeoutMs = (timeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000;
      const result = await runAsAgent(runner, ['bash', '-c', command], { cwd, signal, timeoutMs, onData });
      return { exitCode: result.exitCode };
    },
  };
}

export function readOperations(helper: Helper): ReadOperations {
  return {
    readFile: (file) => op(helper, ['read', file]),
    access: async (file) => void (await op(helper, ['access', file, 'r'])),
  };
}

export function writeOperations(helper: Helper): WriteOperations {
  return {
    writeFile: async (file, content) => void (await op(helper, ['write', file], content)),
    mkdir: async (dir) => void (await op(helper, ['mkdir', dir])),
  };
}

export function editOperations(helper: Helper): EditOperations {
  return {
    readFile: (file) => op(helper, ['read', file]),
    writeFile: async (file, content) => void (await op(helper, ['write', file], content)),
    access: async (file) => void (await op(helper, ['access', file, 'rw'])),
  };
}

/** With `glob` supplied, pi's find never starts fd, which it would otherwise run as root and download if missing. */
export function findOperations(helper: Helper): FindOperations {
  return {
    exists: (file) => json<boolean>(helper, ['exists', file]),
    glob: (pattern, cwd, { ignore, limit }) => json<string[]>(helper, ['glob', cwd, pattern, String(limit), JSON.stringify(ignore)]),
  };
}

/**
 * What pi's grep reads itself: whether the search path is a directory, and
 * files for context lines. The search is ripgrep, which the image's `rg`
 * wrapper runs as the agent user (agent-runtime/rg-as-agent).
 */
export function grepOperations(helper: Helper): GrepOperations {
  return {
    isDirectory: (file) => json<boolean>(helper, ['isdir', file]),
    readFile: async (file) => (await op(helper, ['read', file])).toString('utf8'),
  };
}
