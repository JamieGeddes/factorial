/**
 * Role manifests (#164): one definition per agent role, shared by the host,
 * the invoker and the orchestrator, so a new role is a manifest, the host's
 * part of it, a template block and its states, with no conditionals to add
 * elsewhere. `npm test` here fails on a role conditional outside this
 * package.
 *
 * The manifest is bundled three times (host image, invoker image,
 * orchestrator Lambdas) and they move at different points of a deploy, so a
 * field's meaning stays stable across a release.
 */
import { builder } from './builder.ts';
import type { RoleManifest } from './manifest.ts';
import { reviewer } from './reviewer.ts';

export type { FirstMessageOptions, ModelPurpose, RoleManifest, SensitivePath } from './manifest.ts';

/** Every role, each `factorial_<role>` on its own Runtime. The planner is the builder's plan subagent. */
export const ROLE_NAMES = ['builder', 'reviewer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ROLES: Readonly<Record<RoleName, RoleManifest>> = { builder, reviewer };

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

/** The orchestrator's environment variable holding the role's Runtime ARN, set from the agent stack's outputs. */
export function runtimeArnVariable(role: RoleName): string {
  return `${role.toUpperCase()}_RUNTIME_ARN`;
}

/** The Runtime version's environment variable naming the model for a purpose. */
export function modelVariable(purpose: RoleManifest['models'][number]): string {
  return `FACTORIAL_${purpose.toUpperCase()}_MODEL`;
}
