import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessTokenClaims {
  user_id: string;
  role: string;
  zone_id: number | null;
}

/**
 * Minimal HS256 JWT signer/verifier built on node:crypto so the auth slice needs no
 * registry install. The public surface (`signAccessToken` / `verifyAccessToken`) is
 * what callers depend on — the internals can be swapped for `@nestjs/jwt` later
 * without touching callers or tests.
 */
@Injectable()
export class TokenService {
  private readonly secret = process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me';
  private readonly accessTtlSec = 15 * 60; // H4: 15-min access token

  signAccessToken(claims: AccessTokenClaims): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64urlEncode(
      JSON.stringify({ ...claims, iat: now, exp: now + this.accessTtlSec }),
    );
    const signature = this.sign(`${header}.${payload}`);
    return `${header}.${payload}.${signature}`;
  }

  /** Verifies signature + expiry and returns the claims, or throws if invalid. */
  verifyAccessToken(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed token');
    }
    const [header, payload, signature] = parts;

    const expected = this.sign(`${header}.${payload}`);
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new Error('Invalid signature');
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded.exp === 'number' && decoded.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    return {
      user_id: decoded.user_id,
      role: decoded.role,
      zone_id: decoded.zone_id,
    };
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
