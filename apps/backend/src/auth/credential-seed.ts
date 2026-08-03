import type { PrismaClient } from '../generated/prisma/client';
import { hashPassword } from './password-hasher';

/**
 * Idempotently ensures a `user_credentials` row exists for `userId`, hashed with `password`. This is
 * the ONE credential-writing path shared by every seed/harness (org fixture users, Book harness) so
 * DB-backed login (Issue #91) needs no origin-specific branching: any `users` row with a credential
 * row can authenticate, regardless of how the row was created. A no-op if a credential already exists
 * — never rotates an existing hash, so re-running a seed never changes a password out from under a
 * live test/dev session.
 */
export async function ensureCredential(
  prisma: PrismaClient,
  userId: string,
  password: string,
): Promise<void> {
  const existing = await prisma.userCredential.findUnique({ where: { userId } });
  if (existing) return;

  const { hash, salt } = await hashPassword(password);
  await prisma.userCredential.create({
    data: { userId, passwordHash: hash, passwordSalt: salt, passwordAlgo: 'scrypt' },
  });
}
