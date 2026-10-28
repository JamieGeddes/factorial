/**
 * Bundle the host process, the `quiet` tool (packages/agent-tools) and pi's
 * file helper (src/pi/agent-ops.ts, run as the agent user) into
 * agent-runtime/dist/ for the container image. The Agent SDK stays external:
 * it ships the Claude Code binary as a platform package. So does pi, whose
 * WebAssembly modules load from their own package. The image installs both
 * from agent-runtime/package-lock.json.
 */
import { build } from 'esbuild';

await build({
  entryPoints: { host: 'src/index.ts', quiet: '../agent-tools/src/quiet.ts', 'agent-ops': 'src/pi/agent-ops.ts' },
  outdir: '../../agent-runtime/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
