import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isRole } from '@fsm/shared';
import { AuditService } from '../audit/audit.service';
import type { ConfigActor } from '../common/config-actor';
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
  async create(input: CreateUserInput, actor: ConfigActor): Promise<UserView> {
    if (!isRole(input.role)) {
      throw new BadRequestException(`Invalid role: ${input.role}`);
    }
    try {
      return await this.audit.withAudit(
        {
          actorId: actor.user_id,
          actorRole: actor.role,
          actedAsRole: actor.acted_as_role ?? null,
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

  /** Activates or disables an account, audited. Unknown user → 404. */
  async setStatus(userId: string, status: string, actor: ConfigActor): Promise<UserView> {
    if (status !== 'ACTIVE' && status !== 'DISABLED') {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    const existing = await this.prisma.user.findUnique({ where: { userId } });
    if (!existing) {
      throw new NotFoundException(`User not found: ${userId}`);
    }
    return this.audit.withAudit(
      {
        actorId: actor.user_id,
        actorRole: actor.role,
        actedAsRole: actor.acted_as_role ?? null,
        action: status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ACTIVATED',
        entityType: 'users',
        entityId: userId,
      },
      async (tx) =>
        toUserView(
          await tx.user.update({ where: { userId }, data: { status: status as $Enums.UserStatus } }),
        ),
    );
  }
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
