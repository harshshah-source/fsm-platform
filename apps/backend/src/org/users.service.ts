import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isRole } from '@fsm/shared';
import { auditActor, AuditService } from '../audit/audit.service';
import { revokeAllForUserOn } from '../auth/prisma-refresh-token-store';
import type { RequestActor } from '../common/request-actor';
import { $Enums, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface UserView {
  userId: string;
  name: string;
  role: string;
  zoneId: number | null;
  phone: string;
  email: string;
  status: string;
}

export interface CreateUserInput {
  name: string;
  role: string;
  email: string;
  phone: string;
  zoneId?: number;
}

/**
 * The three things an Operations Head can change about an existing account (#362). Name, email and
 * phone are deliberately absent: they identify a person, and correcting them is a different
 * conversation from re-scoping what that person can reach. `zoneId: null` un-zones a user (the
 * pan-India roles have no zone); omitting the key leaves the zone alone — which is why `undefined`
 * and `null` are not interchangeable here.
 */
export interface UpdateUserInput {
  role?: string;
  zoneId?: number | null;
  status?: string;
}

/** Why a session died when an admin re-scoped or parked the account it belonged to. */
const REVOKE_SCOPE_CHANGED = 'ROLE_OR_ZONE_CHANGED';
const REVOKE_DISABLED = 'ACCOUNT_DISABLED';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<UserView[]> {
    const rows = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toUserView);
  }

  /** Creates an account, audited (AC#6). Invalid role → 400; duplicate email/phone → 409. */
  async create(input: CreateUserInput, actor: RequestActor): Promise<UserView> {
    if (!isRole(input.role)) {
      throw new BadRequestException(`Invalid role: ${input.role}`);
    }
    try {
      return await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'USER_CREATED',
          entityType: 'users',
          entityId: input.email,
        },
        async (tx) =>
          toUserView(
            await tx.user.create({
              data: {
                name: input.name,
                role: input.role as $Enums.Role,
                email: input.email,
                phone: input.phone,
                zoneId: input.zoneId === undefined ? null : BigInt(input.zoneId),
              },
            }),
          ),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A user with that email or phone already exists');
      }
      throw err;
    }
  }

  /** Activates or disables an account, audited. Unknown user → 404. Thin alias over {@link update}. */
  async setStatus(userId: string, status: string, actor: RequestActor): Promise<UserView> {
    return this.update(userId, { status }, actor);
  }

  /**
   * Re-scopes or parks an existing account, audited (#362).
   *
   * Two rules here are not CRUD.
   *
   * **A scope change ends the sessions carrying the old scope.** Role and zone are only half of what
   * a principal can reach; the other half is the refresh token already in their hand, which goes on
   * minting access tokens on the *old* claims until it expires — up to thirty days. A demotion that
   * the live session ignores is worse than no demotion, because the audit log says it happened. So
   * role/zone edits and disables revoke inside the same transaction as the change itself: they
   * commit together or not at all.
   *
   * **The last active Operations Head cannot be demoted or disabled.** OH is the only role that can
   * administer users, so removing the last one makes the change unreversible from inside the product
   * — it becomes a database-console incident. The count is of *other active* OHs: a disabled OH is
   * not a way back in.
   */
  async update(userId: string, input: UpdateUserInput, actor: RequestActor): Promise<UserView> {
    if (input.role === undefined && input.zoneId === undefined && input.status === undefined) {
      throw new BadRequestException('Nothing to update: supply role, zoneId or status');
    }
    if (input.role !== undefined && !isRole(input.role)) {
      throw new BadRequestException(`Invalid role: ${input.role}`);
    }
    if (input.status !== undefined && input.status !== 'ACTIVE' && input.status !== 'DISABLED') {
      throw new BadRequestException(`Invalid status: ${input.status}`);
    }

    const existing = await this.prisma.user.findUnique({ where: { userId } });
    if (!existing) {
      throw new NotFoundException(`User not found: ${userId}`);
    }

    const nextRole = (input.role ?? existing.role) as $Enums.Role;
    const nextZoneId =
      input.zoneId === undefined
        ? existing.zoneId
        : input.zoneId === null
          ? null
          : BigInt(input.zoneId);
    const nextStatus = (input.status ?? existing.status) as $Enums.UserStatus;

    if (input.zoneId !== undefined && input.zoneId !== null) {
      const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(input.zoneId) } });
      if (!zone) {
        throw new BadRequestException(`Zone not found: ${input.zoneId}`);
      }
    }

    await this.guardLastOperationsHead(existing, nextRole, nextStatus);

    const scopeChanged = nextRole !== existing.role || nextZoneId !== existing.zoneId;
    const disabled = nextStatus === 'DISABLED' && existing.status !== 'DISABLED';
    // A status-only edit keeps its own long-standing audit verb; anything touching role or zone is a
    // re-scoping, and reads as one in the log.
    const action = scopeChanged
      ? 'USER_UPDATED'
      : nextStatus === 'DISABLED'
        ? 'USER_DISABLED'
        : 'USER_ACTIVATED';

    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action,
        entityType: 'users',
        entityId: userId,
        metadata: {
          from: { role: existing.role, zoneId: numberOrNull(existing.zoneId), status: existing.status },
          to: { role: nextRole, zoneId: numberOrNull(nextZoneId), status: nextStatus },
          sessionsRevoked: scopeChanged || disabled,
        },
      },
      async (tx) => {
        const updated = await tx.user.update({
          where: { userId },
          data: { role: nextRole, zoneId: nextZoneId, status: nextStatus },
        });
        if (scopeChanged || disabled) {
          // In the same transaction, on purpose — see the class comment above.
          await revokeAllForUserOn(
            tx,
            userId,
            scopeChanged ? REVOKE_SCOPE_CHANGED : REVOKE_DISABLED,
          );
        }
        return toUserView(updated);
      },
    );
  }

  /**
   * Refuses the edit that would leave the platform with no active Operations Head. Only runs when the
   * subject *is* one today and the edit would stop them being one — a no-op for every other account.
   */
  private async guardLastOperationsHead(
    existing: { userId: string; role: string; status: string },
    nextRole: $Enums.Role,
    nextStatus: $Enums.UserStatus,
  ): Promise<void> {
    const isActiveHead = existing.role === 'OPERATIONS_HEAD' && existing.status === 'ACTIVE';
    const staysActiveHead = nextRole === 'OPERATIONS_HEAD' && nextStatus === 'ACTIVE';
    if (!isActiveHead || staysActiveHead) return;

    const survivors = await this.prisma.user.count({
      where: { role: 'OPERATIONS_HEAD', status: 'ACTIVE', userId: { not: existing.userId } },
    });
    if (survivors === 0) {
      throw new ConflictException({
        code: 'LAST_OPERATIONS_HEAD',
        message:
          'This is the only active Operations Head. Promote another one before changing this account — no other role can undo it.',
      });
    }
  }
}

function numberOrNull(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function toUserView(row: {
  userId: string;
  name: string;
  role: string;
  zoneId: bigint | null;
  phone: string;
  email: string;
  status: string;
}): UserView {
  return {
    userId: row.userId,
    name: row.name,
    role: row.role,
    zoneId: row.zoneId === null ? null : Number(row.zoneId),
    phone: row.phone,
    email: row.email,
    status: row.status,
  };
}
