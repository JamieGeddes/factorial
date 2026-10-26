/**
 * Bundle the host process, and the `quiet` tool (packages/agent-tools), into
 * agent-runtime/dist/ for the container image. The Agent SDK stays external: it
 * ships the Claude Code binary as a platform package, so the image installs it
 * from agent-runtime/package-lock.json.
 */
import { build } from 'esbuild';

await build({
  entryPoints: { host: 'src/index.ts', quiet: '../agent-tools/src/quiet.ts' },
  outdir: '../../agent-runtime/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
