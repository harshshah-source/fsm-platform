import { Injectable } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
  zoneId: number | null;
}

interface StoredUser extends AuthenticatedUser {
  salt: string;
  hash: string;
}

/**
 * Dev-seed user store. Replaced by the Postgres-backed store once Docker/DB is
 * available (TB9+). Passwords are scrypt-hashed even in the seed — no plaintext.
 */
@Injectable()
export class InMemoryUserStore {
  private readonly users: StoredUser[] = [
    seedUser('zm.north@fsm.test', 'correct-password', {
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'ZONAL_MANAGER',
      zoneId: 1,
    }),
    seedUser('se.north@fsm.test', 'correct-password', {
      userId: '22222222-2222-2222-2222-222222222222',
      role: 'SERVICE_ENGINEER',
      zoneId: 1,
    }),
    seedUser('ops.head@fsm.test', 'correct-password', {
      userId: '33333333-3333-3333-3333-333333333333',
      role: 'OPERATIONS_HEAD',
      zoneId: null,
    }),
    seedUser('csm@fsm.test', 'correct-password', {
      userId: '44444444-4444-4444-4444-444444444444',
      role: 'CENTRAL_SERVICE_MANAGER',
      zoneId: null,
    }),
    seedUser('wm@fsm.test', 'correct-password', {
      userId: '55555555-5555-5555-5555-555555555555',
      role: 'WAREHOUSE_MANAGER',
      zoneId: null,
    }),
  ];

  findById(userId: string): AuthenticatedUser | null {
    const user = this.users.find((u) => u.userId === userId);
    if (!user) return null;
    const { salt: _salt, hash: _hash, ...safe } = user;
    return safe;
  }

  validateCredentials(email: string, password: string): AuthenticatedUser | null {
    const user = this.users.find((u) => u.email === email);
    if (!user) return null;

    const candidate = scryptSync(password, user.salt, 64);
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return null;
    }

    const { salt: _salt, hash: _hash, ...safe } = user;
    return safe;
  }
}

function seedUser(
  email: string,
  password: string,
  rest: { userId: string; role: string; zoneId: number | null },
): StoredUser {
  const salt = randomBytes(16).toString('hex');
  return {
    email,
    ...rest,
    salt,
    hash: scryptSync(password, salt, 64).toString('hex'),
  };
}
