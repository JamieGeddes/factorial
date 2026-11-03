/**
 * Bundle each Lambda entry point separately into dist/<name>/index.mjs so each
 * function's CodeUri is its own directory. The AWS SDK is bundled
 * too, not taken from the nodejs24.x runtime: the runtime's copy changes with
 * AWS's runtime updates, and on 2026-10-24 one shipped an AgentCore client
 * without InvokeAgentRuntimeCommand, which failed Prepare at load.
 *
 * The functions that run git are served from the orchestration image
 * (orchestration/Dockerfile), so theirs go to orchestration/dist/<name>/,
 * the image's build context, as the invoker's go to invoker/dist/.
 */
import { build } from 'esbuild';

/** Served from the orchestration image, each named by its ImageConfig.Command in templates/orchestration.yml. */
export const imageFunctions = ['collect', 'prepare', 'continue-build', 'prepare-review', 'prepare-verify'];

const zipFunctions = ['intake', 'collect-verifier', 'collect-review', 'open-pr', 'report', 'report-github', 'thread-outcome', 'thread-reconcile', 'live-forward'];

const functions = [
  ...zipFunctions.map((name) => ({ name, outdir: `dist/${name}` })),
  ...imageFunctions.map((name) => ({ name, outdir: `../../orchestration/dist/${name}` })),
];

await Promise.all(
  functions.map(({ name, outdir }) =>
    build({
      entryPoints: { index: `src/functions/${name}.ts` },
      outdir,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      sourcemap: true,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'info',
    }),
  ),
);
