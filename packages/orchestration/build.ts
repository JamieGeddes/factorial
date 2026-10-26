/**
 * Bundle each Lambda entry point separately into dist/<name>/index.mjs so each
 * function's CodeUri is its own directory. The AWS SDK is bundled
 * too, not taken from the nodejs22.x runtime: the runtime's copy changes with
 * AWS's runtime updates, and on 2026-10-24 one shipped an AgentCore client
 * without InvokeAgentRuntimeCommand, which failed Prepare at load.
 */
import { build } from 'esbuild';

const functions = ['intake', 'prepare', 'collect', 'continue-build', 'dispatch-tests', 'prepare-review', 'collect-review', 'open-pr', 'report'];

await Promise.all(
  functions.map((name) =>
    build({
      entryPoints: { index: `src/functions/${name}.ts` },
      outdir: `dist/${name}`,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: true,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'info',
    }),
  ),
);
