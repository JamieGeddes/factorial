/** The verify.mjs bundle: the verifier task's entrypoint, which runs one declared check (runner.ts). */
import { main } from './runner.ts';

process.exitCode = await main();
