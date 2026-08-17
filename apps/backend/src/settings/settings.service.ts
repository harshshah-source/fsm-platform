import { Injectable, OnModuleInit } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
  SE_ASSIGNMENT_THRESHOLD_DESCRIPTION,
  SE_ASSIGNMENT_THRESHOLD_KEY,
} from './assignment-threshold';
import { canWriteSetting } from './setting-authority';


/**
 * Canonical system_settings defaults (Operations-Head-owned, CONTEXT.md "Soft State"
 * and inactivity threshold). Seeding upserts only missing keys, so an operator's later
 * change in Settings is never clobbered by a redeploy.
 */
export const SETTINGS_DEFAULTS: Record<string, { value: unknown; description: string }> = {
  inactivity_threshold_hours: {
    value: 24,
    description:
      'Device silent longer than this is Inactive (canonical 24h). This is a MEASUREMENT definition — ' +
      'it sets is_inactive, the Fleet-Uptime denominator and the Soft Inactive Count zones are graded ' +
      'on. To change when an SE is dispatched, move se_assignment_threshold_hours instead.',
  },
  // #238 — the dispatch-side twin of the key above, deliberately separate. See assignment-threshold.ts.
  [SE_ASSIGNMENT_THRESHOLD_KEY]: {
    value: DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
    description: SE_ASSIGNMENT_THRESHOLD_DESCRIPTION,
  },
  viewed_soft_state_timeout_minutes: {
    value: 90,
    description: 'VIEWED soft state auto-clears after this many minutes.',
  },
  onsite_stale_warning_hours: {
    value: 2,
    description: 'ON_SITE held longer than this raises a ZM stale-work warning.',
  },
  troubleshoot_started_stale_warning_hours: {
    value: 2,
    description: 'TROUBLESHOOT_STARTED held longer than this raises a ZM stale-work warning.',
  },
  plant_cluster_multiplier: {
    value: 1.25,
    description: 'Recommender score boost for additional same-Plant tickets (Plant Cluster Multiplier, ADR-0017).',
  },
  telemetry_retention_days: {
    value: 7,
    description:
      'Days of raw_device_snapshots telemetry retained; older daily partitions are dropped by partition maintenance. Ops-tunable.',
  },
  eligibility_mode: {
    value: 'pgi',
    description:
      'Uptime/ticket eligibility gate: "pgi" (canonical — active PGI within 15 days) or "all-deployed" (interim proxy while the SAP PGI feed is unbuilt — current fitment on an ACTIVE/DEPLOYED vehicle counts). Non-Op exclusion applies in both modes.',
  },
  recompute_canary_threshold_pct: {
    value: 5,
    description:
      '#130 L5 semantic canary: a relative eligible-count swing beyond this percent between consecutive device_states recomputes (either direction) logs a LOUD warning. Warns only — never blocks the pipeline.',
  },
};

/**
 * Keys the generic `PUT /api/settings/:key` must not write, and the endpoint that owns each. A key
 * lands here when storing its value is only half the job — see {@link SettingsService.set}.
 */
export const SPECIALISED_SETTING_WRITERS: Record<string, string> = {
  dispatch_cron: 'PUT /api/schedules/dispatch-schedule',
  // #238 — writing this number is the smaller half of the job: it is co-owned with the CSM, it can be
  // locked by the Operations Head, and every change has to leave a revertible trail. The generic path
  // does none of that, so it refuses the key rather than half-applying it.
  [SE_ASSIGNMENT_THRESHOLD_KEY]: 'PUT /api/settings/assignment-threshold',
};

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Seed canonical defaults on boot so the registry is always readable. */
  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
  }

  /** Idempotently inserts any missing default. Never overwrites an existing value. */
  async seedDefaults(): Promise<void> {
    for (const [key, { value, description }] of Object.entries(SETTINGS_DEFAULTS)) {
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: value as object, description },
        update: {},
      });
    }
  }

  /** Reads one setting's value, or undefined if the key is not in the registry. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return row?.value as T | undefined;
  }

  /** Returns the whole registry as a flat key→value map. */
  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.systemSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * Upserts one setting's value inside an audited transaction, so the config change and its
   * audit_logs row commit together (Issue 02 AC#6 — every config mutation is audited).
   */
  async set(
    key: string,
    value: unknown,
    actor: RequestActor,
  ): Promise<
    | { key: string; value: unknown }
    | { result: 'DELEGATED'; key: string; endpoint: string }
    | { result: 'LOCKED'; key: string; lockedByRole: string | null; lockReason: string | null }
  > {
    // #213 — some keys have a specialised writer that does more than store a value. `dispatch_cron` is
    // validated at write time and re-registers the live cron job; writing it through this generic path
    // would accept an unparseable expression AND leave the job on the old schedule, so the setting
    // would read as changed while dispatch kept firing at the old hour. Refuse loudly instead.
    const owner = SPECIALISED_SETTING_WRITERS[key];
    if (owner) return { result: 'DELEGATED', key, endpoint: owner };

    // #238 — the lock is a property of the registry, not of one endpoint. This route is
    // Operations-Head-only today and the OH is never locked out, so the check is inert here by
    // construction; it exists so that widening a key's write roles later cannot accidentally route
    // around the lock, which would make "the OH has the final decision" true only on one code path.
    const existing = await this.prisma.systemSetting.findUnique({ where: { key } });
    const verdict = canWriteSetting(key, actor.role, existing);
    if (!verdict.allowed && verdict.code === 'SETTING_LOCKED') {
      return {
        result: 'LOCKED',
        key,
        lockedByRole: existing?.lockedByRole ?? null,
        lockReason: existing?.lockReason ?? null,
      };
    }
    return this.setUnchecked(key, value, actor);
  }

  /** The plain registry write, once {@link set} has established the key has no specialised owner. */
  private async setUnchecked(
    key: string,
    value: unknown,
    actor: RequestActor,
  ): Promise<{ key: string; value: unknown }> {
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SETTING_UPDATED',
        entityType: 'system_settings',
        entityId: key,
      },
      async (tx) => {
        const row = await tx.systemSetting.upsert({
          where: { key },
          create: { key, value: value as object },
          update: { value: value as object },
        });
        return { key: row.key, value: row.value };
      },
    );
  }
}
