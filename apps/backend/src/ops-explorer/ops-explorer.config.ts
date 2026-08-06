/**
 * Operations Data Explorer — feature configuration (#217).
 *
 * Two independent flags, deliberately not one:
 *
 *  - `OPS_EXPLORER_ENABLED` gates the whole surface. **Default off**, in every environment. The
 *    explorer is a diagnostic instrument, not a product feature, so it is opt-in per deployment
 *    rather than opt-out. When off, every route 404s (see `OpsExplorerEnabledGuard`).
 *
 *  - `OPS_EXPLORER_DEVELOPER_MODE` gates the *lineage* layer on top — source columns, SQL, timings,
 *    raw responses. It defaults to **on outside production and off in production**, which is the
 *    operator's ruling: a developer running locally should not have to set a second flag to see the
 *    thing the tool exists for, while production must opt in explicitly and visibly.
 *
 * Developer mode can never be on while the feature is off — it is a layer, not a separate surface.
 *
 * Kept a pure function of `env` (no `@nestjs/config`, matching `boot-config.ts`) so it is directly
 * unit-testable and so the flags can be evaluated in a guard without DI plumbing.
 */

export interface OpsExplorerConfig {
  /** The whole feature. False ⇒ every `/api/ops-explorer/*` route behaves as if it does not exist. */
  enabled: boolean;
  /**
   * The lineage/diagnostics layer. Implies `enabled`. When false the deep fields are omitted from
   * every response **server-side** — the browser never receives them, so this is an access control,
   * not a display preference.
   */
  developerMode: boolean;
}

/** Env values accepted as true. Anything else — including unset, `'1'`-adjacent typos — is false. */
function readFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function readOpsExplorerConfig(env: NodeJS.ProcessEnv = process.env): OpsExplorerConfig {
  const enabled = readFlag(env.OPS_EXPLORER_ENABLED) ?? false;

  // Unset ⇒ derive from the environment; set ⇒ the operator's explicit value wins in both directions,
  // so production CAN turn lineage on deliberately and a staging box CAN turn it off.
  const devDefault = (env.NODE_ENV ?? 'development') !== 'production';
  const developerMode = (readFlag(env.OPS_EXPLORER_DEVELOPER_MODE) ?? devDefault) && enabled;

  return { enabled, developerMode };
}
