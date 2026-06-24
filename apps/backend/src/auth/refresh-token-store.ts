import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

interface RefreshRecord {
  userId: string;
  expiresAt: number; // epoch ms
  revoked: boolean;
}

/**
 * TEMPORARY in-memory refresh-token rotation/revocation store.
 *
 * Replace with the persistent (Postgres) store when DB-backed auth lands — see ADR-0025
 * and TB6+. Tokens are opaque, single-use: `issue` mints one; `consume` validates and
 * revokes it (so reuse of a rotated token is detected and rejected). Process-local state
 * only — does not survive restart and is not shared across instances.
 */
@Injectable()
export class InMemoryRefreshTokenStore {
  private readonly records = new Map<string, RefreshRecord>();
  private readonly ttlMs = 30 * 24 * 60 * 60 * 1000; // H4: 30-day refresh token

  issue(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.records.set(token, { userId, expiresAt: Date.now() + this.ttlMs, revoked: false });
    return token;
  }

  /** Validates and consumes (revokes) the token. Returns the userId, or null if invalid. */
  consume(token: string): string | null {
    const record = this.records.get(token);
    if (!record || record.revoked || record.expiresAt < Date.now()) {
      return null;
    }
    record.revoked = true;
    return record.userId;
  }
}
