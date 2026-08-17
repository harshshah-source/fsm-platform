import { Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';
import {
  ASSIGNMENT_THRESHOLD_OPTIONS,
  DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
  SE_ASSIGNMENT_THRESHOLD_DESCRIPTION,
  SE_ASSIGNMENT_THRESHOLD_KEY,
  coerceStoredThreshold,
  parseAssignmentThresholdHours,
} from './assignment-threshold';
import { canWriteSetting, writeRolesFor, type SettingLock } from './setting-authority';

/** How many history rows the read surface returns — enough to back a revert picker, bounded so the
 *  settings page never pulls an unbounded table. */
const HISTORY_LIMIT = 25;

export interface ThresholdChangeView {
  id: string;
  previousHours: number | null;
  newHours: number | null;
  changeType: 'SET' | 'REVERT' | 'LOCK' | 'UNLOCK';
  actorId: string;
  actorRole: string;
  reason: string | null;
  revertedFromId: string | null;
  createdAt: string;
}

export interface ThresholdLockView {
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedByRole: string | null;
  lockReason: string | null;
}

export interface AssignmentThresholdView {
  hours: number;
  options: readonly number[];
  /** The default the platform ships with — so the UI can mark it and offer "back to canonical". */
  defaultHours: number;
  lock: ThresholdLockView;
  /** Roles permitted to write the key at all, lock aside. Drives the UI's read-only rendering. */
  writeRoles: readonly string[];
  /**
   * `inactivity_threshold_hours` as it currently stands. Present because the operator's decision is
   * only meaningful next to it: below this figure the threshold opens tickets for devices the rest of
   * the platform does not yet call Inactive, and above it a device can be Inactive on every dashboard
   * with no SE dispatched. Neither is wrong — both must be *visible* at the moment of choosing.
   */
  inactivityThresholdHours: number;
  /** What the caller may do, resolved server-side so the UI never re-derives the authority rules. */
  canEdit: boolean;
  canLock: boolean;
  updatedAt: string | null;
  history: ThresholdChangeView[];
}

export type ThresholdWriteOutcome =
  | { result: 'OK'; view: AssignmentThresholdView }
  | { result: 'INVALID'; reason: string }
  | { result: 'FORBIDDEN'; code: 'ROLE_NOT_PERMITTED' | 'SETTING_LOCKED'; reason: string }
  | { result: 'NOT_FOUND'; reason: string };

const toChangeView = (r: {
  id: bigint;
  previousValue: unknown;
  newValue: unknown;
  changeType: string;
  actorId: string;
  actorRole: string;
  reason: string | null;
  revertedFromId: bigint | null;
  createdAt: Date;
}): ThresholdChangeView => ({
  id: r.id.toString(),
  previousHours: typeof r.previousValue === 'number' ? r.previousValue : null,
  newHours: typeof r.newValue === 'number' ? r.newValue : null,
  changeType: r.changeType as ThresholdChangeView['changeType'],
  actorId: r.actorId,
  actorRole: r.actorRole,
  reason: r.reason,
  revertedFromId: r.revertedFromId != null ? r.revertedFromId.toString() : null,
  createdAt: r.createdAt.toISOString(),
});

/**
 * #238 — the governed writer for the SE-assignment threshold.
 *
 * The generic `PUT /api/settings/:key` deliberately refuses this key (it is listed in
 * `SPECIALISED_SETTING_WRITERS`, the same #213 mechanism that protects `dispatch_cron`), because
 * storing the number is the smaller half of the job. The larger half is the governance the operator
 * asked for and this service owns:
 *
 *  - **Two writers, one owner.** OH and CSM may both set the value. The OH may additionally *lock*
 *    the key, after which only the OH may write it. That is what "the OH has the final decision"
 *    means mechanically: not an approval queue that stalls the CSM's day-to-day work, but a
 *    reversible veto the OH can exercise the moment they disagree.
 *  - **Every change is recoverable.** Each write appends a `setting_changes` row carrying the value
 *    it replaced, so `revert` is a first-class operation against a specific past decision rather than
 *    a human retyping a number they hope was the old one.
 *  - **Nothing is written unaudited.** Value row, history row and `audit_logs` row commit in one
 *    transaction (`AuditService.withAudit`), so there is no state in which the threshold moved and
 *    the record of who moved it did not.
 */
@Injectable()
export class AssignmentThresholdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The full read surface: current value, ladder, lock, the caller's own permissions, and history. */
  async view(actor: Pick<RequestActor, 'role'>): Promise<AssignmentThresholdView> {
    const [row, inactivityRow, history] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'inactivity_threshold_hours' } }),
      this.prisma.settingChange.findMany({
        where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
      }),
    ]);

    const lock: SettingLock = {
      lockedAt: row?.lockedAt ?? null,
      lockedBy: row?.lockedBy ?? null,
      lockedByRole: row?.lockedByRole ?? null,
      lockReason: row?.lockReason ?? null,
    };
    const verdict = canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, actor.role, lock);
    const inactivityHours = Number(inactivityRow?.value);

    return {
      hours: coerceStoredThreshold(row?.value),
      options: ASSIGNMENT_THRESHOLD_OPTIONS,
      defaultHours: DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
      lock: {
        locked: lock.lockedAt != null,
        lockedAt: lock.lockedAt ? lock.lockedAt.toISOString() : null,
        lockedBy: lock.lockedBy,
        lockedByRole: lock.lockedByRole,
        lockReason: lock.lockReason,
      },
      writeRoles: writeRolesFor(SE_ASSIGNMENT_THRESHOLD_KEY),
      inactivityThresholdHours: Number.isFinite(inactivityHours) ? inactivityHours : 24,
      canEdit: verdict.allowed,
      canLock: actor.role === 'OPERATIONS_HEAD',
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      history: history.map(toChangeView),
    };
  }

  /** Set the threshold to one of the ladder's values. OH always; CSM unless the key is locked. */
  async set(rawHours: unknown, reason: string | null, actor: RequestActor): Promise<ThresholdWriteOutcome> {
    const parsed = parseAssignmentThresholdHours(rawHours);
    if (!parsed.ok) {
      return {
        result: 'INVALID',
        reason:
          parsed.reason === 'NOT_A_NUMBER'
            ? 'The assignment threshold must be a number of hours.'
            : `The assignment threshold must be one of the allowed options: ${ASSIGNMENT_THRESHOLD_OPTIONS.join(', ')} hours.`,
      };
    }
    return this.write(parsed.hours, reason, actor, 'SET', null);
  }

  /**
   * Restore the value recorded by a past `setting_changes` row. Operations-Head only — a revert is
   * the OH overruling a decision, which is precisely the authority the CSM does not hold.
   *
   * It replays the *value*, not the row: the revert appends its own history entry pointing back at
   * the one it restored, so the trail reads forward (`… → 48 → reverted to 24 (from change #7)`)
   * rather than losing the intervening decision the way an in-place edit would.
   */
  async revert(changeId: unknown, reason: string | null, actor: RequestActor): Promise<ThresholdWriteOutcome> {
    if (actor.role !== 'OPERATIONS_HEAD') {
      return {
        result: 'FORBIDDEN',
        code: 'ROLE_NOT_PERMITTED',
        reason: 'Only the Operations Head can revert the assignment threshold.',
      };
    }
    const id = typeof changeId === 'string' || typeof changeId === 'number' ? String(changeId) : '';
    if (!/^\d+$/.test(id)) return { result: 'INVALID', reason: 'A change id is required to revert.' };

    const target = await this.prisma.settingChange.findFirst({
      where: { id: BigInt(id), key: SE_ASSIGNMENT_THRESHOLD_KEY },
    });
    if (target === null) return { result: 'NOT_FOUND', reason: `No threshold change with id ${id}.` };

    // LOCK/UNLOCK rows carry no value; reverting to one is meaningless rather than merely unusual.
    const parsed = parseAssignmentThresholdHours(target.newValue);
    if (!parsed.ok) {
      return { result: 'INVALID', reason: `Change ${id} did not record a threshold value to revert to.` };
    }
    return this.write(parsed.hours, reason, actor, 'REVERT', BigInt(id));
  }

  /** The shared write path for SET and REVERT — permission check, then one audited transaction. */
  private async write(
    hours: number,
    reason: string | null,
    actor: RequestActor,
    changeType: 'SET' | 'REVERT',
    revertedFromId: bigint | null,
  ): Promise<ThresholdWriteOutcome> {
    const existing = await this.prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
    const verdict = canWriteSetting(SE_ASSIGNMENT_THRESHOLD_KEY, actor.role, existing);
    if (!verdict.allowed) return { result: 'FORBIDDEN', code: verdict.code, reason: this.refusal(verdict.code, existing) };

    const previous = existing === null ? null : coerceStoredThreshold(existing.value);

    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: changeType === 'REVERT' ? 'SE_ASSIGNMENT_THRESHOLD_REVERTED' : 'SE_ASSIGNMENT_THRESHOLD_UPDATED',
        entityType: 'system_settings',
        entityId: SE_ASSIGNMENT_THRESHOLD_KEY,
        metadata: { previousHours: previous, newHours: hours, reason, revertedFromId: revertedFromId?.toString() ?? null },
      },
      async (tx) => {
        await tx.systemSetting.upsert({
          where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
          create: { key: SE_ASSIGNMENT_THRESHOLD_KEY, value: hours, description: SE_ASSIGNMENT_THRESHOLD_DESCRIPTION },
          update: { value: hours },
        });
        await tx.settingChange.create({
          data: {
            key: SE_ASSIGNMENT_THRESHOLD_KEY,
            // Prisma requires the explicit sentinel for a SQL NULL in a nullable Json column; a bare
            // `null` is rejected as the ambiguous JSON-null. The first-ever write has no predecessor.
            previousValue: previous ?? Prisma.DbNull,
            newValue: hours,
            changeType,
            actorId: actor.userId,
            actorRole: actor.role,
            reason,
            revertedFromId,
          },
        });
      },
    );

    return { result: 'OK', view: await this.view(actor) };
  }

  /**
   * Lock (`locked: true`) or release (`locked: false`) the key. Operations-Head only, by definition:
   * a lock the locked-out party could lift would not be a final decision.
   */
  async setLock(locked: boolean, reason: string | null, actor: RequestActor): Promise<ThresholdWriteOutcome> {
    if (actor.role !== 'OPERATIONS_HEAD') {
      return {
        result: 'FORBIDDEN',
        code: 'ROLE_NOT_PERMITTED',
        reason: 'Only the Operations Head can lock or unlock the assignment threshold.',
      };
    }

    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: locked ? 'SE_ASSIGNMENT_THRESHOLD_LOCKED' : 'SE_ASSIGNMENT_THRESHOLD_UNLOCKED',
        entityType: 'system_settings',
        entityId: SE_ASSIGNMENT_THRESHOLD_KEY,
        metadata: { reason },
      },
      async (tx) => {
        // Upsert rather than update: locking must work even if the seed has not run in this database,
        // and a lock on a missing key would otherwise silently do nothing.
        await tx.systemSetting.upsert({
          where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
          create: {
            key: SE_ASSIGNMENT_THRESHOLD_KEY,
            value: DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
            description: SE_ASSIGNMENT_THRESHOLD_DESCRIPTION,
            lockedAt: locked ? new Date() : null,
            lockedBy: locked ? actor.userId : null,
            lockedByRole: locked ? actor.role : null,
            lockReason: locked ? reason : null,
          },
          update: {
            lockedAt: locked ? new Date() : null,
            lockedBy: locked ? actor.userId : null,
            lockedByRole: locked ? actor.role : null,
            lockReason: locked ? reason : null,
          },
        });
        await tx.settingChange.create({
          data: {
            key: SE_ASSIGNMENT_THRESHOLD_KEY,
            // A lock/unlock moves authority, not value — both value columns stay SQL NULL, which is
            // what makes `revert` able to refuse them rather than restore a meaningless "value".
            previousValue: Prisma.DbNull,
            newValue: Prisma.DbNull,
            changeType: locked ? 'LOCK' : 'UNLOCK',
            actorId: actor.userId,
            actorRole: actor.role,
            reason,
          },
        });
      },
    );

    return { result: 'OK', view: await this.view(actor) };
  }

  private refusal(code: 'ROLE_NOT_PERMITTED' | 'SETTING_LOCKED', lock: SettingLock | null): string {
    if (code === 'ROLE_NOT_PERMITTED') return 'Your role cannot change the SE-assignment threshold.';
    const who = lock?.lockedByRole ?? 'the Operations Head';
    const why = lock?.lockReason ? ` — ${lock.lockReason}` : '';
    return `The SE-assignment threshold is locked by ${who}${why}. Only the Operations Head can change it while it is locked.`;
  }
}
