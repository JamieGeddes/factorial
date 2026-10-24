/**
 * Recognising a builder that stopped before finishing. The invoker exits
 * with INCOMPLETE_EXIT_CODE when the builder stops for any reason other than
 * a finished run (end_turn on the harness, success on the Runtime), and the
 * ECS task's failure cause carries that code. Collect uses it to decide
 * whether the build continues in another round; Report uses it to say what
 * happened.
 */

/** `INCOMPLETE_EXIT_CODE` in packages/invoker/src/role.ts. */
export const INCOMPLETE_EXIT_CODE = 3;

export interface StepFailure {
  Error?: string | undefined;
  Cause?: string | undefined;
}

function safeJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the failure is the builder's task exiting as incomplete: its iteration or time limit, not an error. */
export function builderIncomplete(error: StepFailure | null | undefined): boolean {
  if (error?.Error !== 'States.TaskFailed') return false;
  const containers = safeJson(error.Cause)?.Containers;
  return (
    Array.isArray(containers) &&
    containers.some((c: unknown) => {
      const container = c as { Name?: unknown; ExitCode?: unknown } | null;
      return container?.Name === 'invoker' && container.ExitCode === INCOMPLETE_EXIT_CODE;
    })
  );
}
