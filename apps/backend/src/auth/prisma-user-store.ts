import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashDummyPassword, verifyPassword } from './password-hasher';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
  zoneId: number | null;
}

/**
 * Postgres-backed user store (Issue #91 S2) — replaces `InMemoryUserStore`. Reads `users` JOINed with
 * `user_credentials`; the public shape (`validateCredentials` / `findById`) is unchanged from the
 * in-memory store it replaces, so `AuthService` needed no interface change, only a DI swap.
 */
@Injectable()
export class PrismaUserStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    return user ? toAuthenticatedUser(user) : null;
  }

  /**
   * Verifies email + password against the DB with async `crypto.scrypt` (never `scryptSync` — see
   * `password-hasher.ts`). An unknown email, or a user row with no credential row yet (e.g. created
   * via `POST /api/org/users` but never issued a credential), still runs the dummy hash before
   * returning null so response timing never reveals which emails exist.
   */
  async validateCredentials(email: string, password: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { credential: true },
    });

    if (!user || !user.credential) {
      await hashDummyPassword(password);
      return null;
    }

    const ok = await verifyPassword(password, user.credential.passwordHash, user.credential.passwordSalt);
    if (!ok) return null;

    return toAuthenticatedUser(user);
  }
}

function toAuthenticatedUser(user: {
  userId: string;
  email: string;
  role: string;
  zoneId: bigint | null;
}): AuthenticatedUser {
  return {
    userId: user.userId,
    email: user.email,
    role: user.role,
    zoneId: user.zoneId === null ? null : Number(user.zoneId),
  };
}
