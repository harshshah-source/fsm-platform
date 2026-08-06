import { useEffect, useState } from 'react';
import { apiOpsExplorerMeta, type ExplorerMeta } from '../../api/opsExplorer';

export type OpsExplorerAvailability =
  | { state: 'loading' }
  /** The backend 404'd `meta` — `OPS_EXPLORER_ENABLED` is off here. Not an error; hide the surface. */
  | { state: 'disabled' }
  | { state: 'forbidden' }
  | { state: 'error'; message: string }
  | { state: 'ready'; meta: ExplorerMeta };

/**
 * Resolves whether the Operations Data Explorer exists on this backend, and with which capabilities.
 *
 * Deliberately NOT built on `useApiResource`: that hook collapses every failure into one `error` string,
 * and this feature's whole access model turns on distinguishing three of them — 404 (feature off, hide
 * it silently), 403 (role refused, say so), and anything else (a real error worth reporting). Flattening
 * those would make a disabled feature look broken, which is exactly the confusion the 404-not-403 choice
 * on the backend was made to avoid.
 *
 * The result is cached at module scope for the session: the flags do not change under a signed-in user,
 * and both the sidebar and the page ask this question, so without the cache every navigation re-hits
 * `meta` — and `meta` writes an audit row on every call.
 */
let cached: OpsExplorerAvailability | null = null;
let inFlight: Promise<OpsExplorerAvailability> | null = null;

/** Test seam: drop the module-scope cache. */
export function resetOpsExplorerMetaCache(): void {
  cached = null;
  inFlight = null;
}

async function load(): Promise<OpsExplorerAvailability> {
  try {
    const meta = await apiOpsExplorerMeta();
    return meta === null ? { state: 'disabled' } : { state: 'ready', meta };
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'REQUEST_FAILED_403') return { state: 'forbidden' };
    return { state: 'error', message: e instanceof Error ? e.message : 'Failed to load' };
  }
}

/**
 * `enabled: false` short-circuits to `disabled` without a request. The sidebar passes
 * `role === 'OPERATIONS_HEAD'` so a Zonal Manager's every page load does not fire a request that can
 * only ever 403 — and, more to the point, so the audit log is not filled with `OPS_EXPLORER_ACCESSED`
 * rows for people who never opened the tool.
 */
export function useOpsExplorerMeta(enabled = true): OpsExplorerAvailability {
  const [state, setState] = useState<OpsExplorerAvailability>(
    enabled ? (cached ?? { state: 'loading' }) : { state: 'disabled' },
  );

  useEffect(() => {
    if (!enabled) {
      setState({ state: 'disabled' });
      return;
    }
    if (cached) {
      setState(cached);
      return;
    }
    let alive = true;
    inFlight ??= load();
    void inFlight.then((result) => {
      cached = result;
      inFlight = null;
      if (alive) setState(result);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return state;
}
