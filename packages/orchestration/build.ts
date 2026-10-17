/**
 * Bundle each Lambda entry point separately into dist/<name>/index.mjs so each
 * function's CodeUri is its own directory. The AWS SDK is provided by the
 * nodejs22.x runtime and left external.
 */
import { build } from 'esbuild';

const functions = ['prepare', 'collect', 'dispatch-tests', 'open-pr', 'report'];

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
      external: ['@aws-sdk/*'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'info',
    }),
  ),
);
