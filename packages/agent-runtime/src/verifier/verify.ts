/** The verify.mjs bundle: run one declared check in a verifier session (command.ts). */
import { main } from './command.ts';

process.exitCode = await main(process.argv.slice(2));
