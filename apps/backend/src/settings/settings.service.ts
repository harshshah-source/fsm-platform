import { Injectable, OnModuleInit } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';


/**
 * Canonical system_settings defaults (Operations-Head-owned, CONTEXT.md "Soft State"
 * and inactivity threshold). Seeding upserts only missing keys, so an operator's later
 * change in Settings is never clobbered by a redeploy.
 */
export const SETTINGS_DEFAULTS: Record<string, { value: unknown; description: string }> = {
  inactivity_threshold_hours: {
    value: 24,
    description: 'Device silent longer than this is Inactive (canonical 24h).',
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
