/**
 * Entry point. Every Runtime runs this image: a role's Runtime runs the
 * agent host (agent-host.ts), and the verifier Runtime (#167), which runs no
 * model, runs a host that only answers health checks (verifier/host.ts).
 * `FACTORIAL_ROLE` on the Runtime version says which.
 */
import { VERIFIER_RUNTIME } from '@factorial/roles';

if (process.env.FACTORIAL_ROLE === VERIFIER_RUNTIME) (await import('./verifier/host.ts')).serveVerifier();
else await import('./agent-host.ts');
