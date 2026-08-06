import type { Role } from '@fsm/shared';

/**
 * The Operations Data Explorer's authorization seam (#217 AC-3).
 *
 * **This constant is the deliverable, not the value in it.** The operator ruled against introducing a
 * sixth RBAC role for a diagnostic tool — CONTEXT.md:28 is explicit that no Admin persona exists and
 * that Operations Head is already the system configurator — but also asked that a future
 * `PLATFORM_DEVELOPER` role be addable "without redesigning the feature or its architecture".
 *
 * That property only holds if the allow-list exists in exactly one place. Every `@Roles(...)` in this
 * module spreads this tuple; the admin route guard reads the same list off `GET /api/ops-explorer/meta`.
 * Adding the role is then:
 *
 *   1. append `'PLATFORM_DEVELOPER'` to `ROLES` in `packages/shared/src/index.ts`
 *   2. append it here
 *
 * and nothing else in this module changes shape. A test asserts no handler hard-codes a role string,
 * because inlining `'OPERATIONS_HEAD'` on one handler is how that property silently dies.
 */
export const OPS_EXPLORER_ROLES: readonly Role[] = ['OPERATIONS_HEAD'] as const;

/**
 * Spreadable copy for `@Roles(...)`, which takes varargs of `string`. Kept separate from the typed
 * tuple above so the decorator call site stays `@Roles(...OPS_EXPLORER_ROLE_NAMES)` and TypeScript
 * does not widen the exported `Role[]`.
 */
export const OPS_EXPLORER_ROLE_NAMES: string[] = [...OPS_EXPLORER_ROLES];
