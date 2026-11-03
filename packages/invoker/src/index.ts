/**
 * The invoker's entry point. One image and one task definition serve every
 * stage that waits on a session: the state machine names the mode. Without
 * one, the task runs an agent role (agent.ts); `MODE=verify` runs one of a
 * target's declared checks in a verifier session (verify.ts, #167).
 */
if (process.env.MODE === 'verify') await import('./verify.ts');
else await import('./agent.ts');
