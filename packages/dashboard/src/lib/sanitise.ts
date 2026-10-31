/**
 * Everything a model, a tool or a requester wrote is untrusted. React renders
 * it as text, never as markup; this removes what could still disguise or
 * reshape it on screen: control characters (newline and tab kept) and
 * bidirectional overrides, as `sanitise` in `scripts/tail-run.ts` does.
 */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function sanitise(text: string): string {
  return text.replace(UNSAFE, '');
}

/** Untrusted text on one line: sanitised, whitespace collapsed. */
export function oneLine(text: string): string {
  return sanitise(text).replace(/\s+/g, ' ').trim();
}

/** Any value as sanitised text: strings as they are, anything else empty. */
export function text(value: unknown): string {
  return typeof value === 'string' ? sanitise(value) : '';
}
