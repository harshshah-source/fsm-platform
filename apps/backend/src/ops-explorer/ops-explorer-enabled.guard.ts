import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { readOpsExplorerConfig, type OpsExplorerConfig } from './ops-explorer.config';

/**
 * Feature-flag guard for the Operations Data Explorer (#217 AC-1).
 *
 * Throws **404, not 403**, when `OPS_EXPLORER_ENABLED` is off. That is deliberate: a 403 confirms the
 * route exists and merely refuses the caller, which for a diagnostic surface that is off in production
 * is more information than an unauthenticated prober should get. Off means "there is no such endpoint
 * here", and the admin app treats a 404 on `meta` as "feature absent" rather than as an error state.
 *
 * The flags are read **per request**, not captured at construction. The cron schedulers in this repo
 * resolve their expressions once at decorator evaluation and therefore need a restart to pick up a
 * flag flip (`integration-scheduler.service.ts:46-47`); for a read-only debugging tool the opposite
 * trade is right — an operator turning the explorer on to investigate a live incident should not have
 * to bounce the process. `process.env` reads are not a measurable cost next to the queries this gates.
 */
@Injectable()
export class OpsExplorerEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!readOpsExplorerConfig().enabled) {
      throw new NotFoundException();
    }
    return true;
  }
}

/** Convenience for services/controllers that need the live flags rather than just the gate. */
@Injectable()
export class OpsExplorerConfigService {
  get current(): OpsExplorerConfig {
    return readOpsExplorerConfig();
  }

  get developerMode(): boolean {
    return this.current.developerMode;
  }
}
