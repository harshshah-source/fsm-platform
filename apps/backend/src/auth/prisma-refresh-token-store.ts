import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface IssueTokenParams {
  userId: string;
  /** Opaque per-install id from `X-Device-Id`, or a server-generated fallback — see auth.controller.ts. */
  deviceId: string;
  deviceLabel?: string | null;
  /** Rotation lineage — the id of the token this issue() call is rotating, if any. */
  rotatedFrom?: bigint;
}

export interface ConsumedToken {
  userId: string;
  tokenId: bigint;
  deviceId: string;
}

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // H4: 30-day refresh token

/**
 * Postgres-backed refresh-token store (Issue #91 S3) — replaces `InMemoryRefreshTokenStore`. Only a
 * SHA-256 hash of the token is ever persisted (schema doc comment: "a database read can never yield a
 * usable token"). Implements the same single-use rotation contract (`issue` / `consume`) as the store
 * it replaces, plus:
 *
 *  - **D-2 one-active-device, replace-on-login.** Every `issue()` call first revokes whatever was
 *    still active for that `userId` (`revokedReason: 'REPLACED_BY_NEW_DEVICE'`). On a real new-device
 *    login this ends the previous session. On a plain refresh it is a no-op, because `consume()`
 *    already revoked the one row that was active (the one being rotated) before `issue()` runs — so
 *    the invariant "at most one active refresh token per user" holds after every call, not just at
 *    login.
 *  - **`revokeAllForUser`** — a future admin-forced-logout hook; no route calls it yet (#91 AC).
 *  - **`revoke`** — revokes the presented token without rotating it, for `POST /api/auth/logout`.
 */
@Injectable()
export class PrismaRefreshTokenStore {
  constructor(private readonly prisma: PrismaService) {}

  async issue(params: IssueTokenParams): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId: params.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REPLACED_BY_NEW_DEVICE' },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: params.userId,
          tokenHash,
          deviceId: params.deviceId,
          deviceLabel: params.deviceLabel ?? null,
          expiresAt,
          rotatedFrom: params.rotatedFrom ?? null,
        },
      }),
    ]);

    return token;
  }

  /** Validates and consumes (revokes, reason `ROTATED`) the token. Returns null if unknown/revoked/expired. */
  async consume(token: string): Promise<ConsumedToken | null> {
    const tokenHash = hashToken(token);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt !== null || row.expiresAt < new Date()) {
      return null;
    }

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED', lastSeenAt: new Date() },
    });

    return { userId: row.userId, tokenId: row.id, deviceId: row.deviceId };
  }

  /** Revokes the presented token WITHOUT rotating it — logout. `null` if unknown or already revoked;
   *  otherwise the revoked row's `userId` (#76 — so logout can also clear that user's device push
   *  token in one place). */
  async revoke(token: string, reason: string): Promise<{ userId: string } | null> {
    const tokenHash = hashToken(token);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt !== null) return null;

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return { userId: row.userId };
  }

  /**
   * Revokes every currently-active token for a user — the admin-forced-logout path. Callers that
   * must revoke *as part of* another change (a role or zone edit, #362) call
   * {@link revokeAllForUserOn} with their own transaction client instead, so the two commit together.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    return revokeAllForUserOn(this.prisma, userId, reason);
  }
}

/** The narrowest client `revokeAllForUserOn` needs — `PrismaService` and a `$transaction` client both fit. */
export type RefreshTokenWriter = Pick<Prisma.TransactionClient, 'refreshToken'>;

/**
 * Revokes every active refresh token for `userId` on the supplied client, returning how many died.
 *
 * Taking the client as a parameter is the whole point (#362). A privilege change and the revocation
 * of the sessions carrying the old privilege must be one atomic fact: if the role update commits and
 * the revocation does not, the audit log records a demotion that a live session goes on ignoring
 * until the refresh token expires — the worst of the three possible outcomes, because it looks
 * finished. Passing the `tx` from `AuditService.withAudit` makes the mutation, its audit row and the
 * revocation commit or roll back as one.
 */
export async function revokeAllForUserOn(
  client: RefreshTokenWriter,
  userId: string,
  reason: string,
): Promise<number> {
  const result = await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
