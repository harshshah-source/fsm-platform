import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, short-lived snapshot tokens for admin preview flows (#251, extracted from #179).
 *
 * **What the token is for.** A preview shows the operator a projection of the world, and the world
 * keeps moving. The token carries a signed snapshot of the figures the operator was actually shown,
 * so a later request can tell "this decision was made against the state you saw" from "this decision
 * was made against a screen that is now stale". Without it the two are indistinguishable and the
 * server has to trust a number the client echoes back.
 *
 * **Why it is signed rather than stored.** The snapshot is small, single-use and expires in minutes;
 * a table for it would need its own lifecycle and cleanup for no additional guarantee. HMAC gives
 * integrity without state — the server can verify it minted the value without remembering it.
 *
 * **Why this module exists.** #179 built exactly this for bulk-unassign, module-private
 * (`bulk-unassign.service.ts:82-130`). #251 needs the same thing for the scheduler preview, and the
 * one thing that must not happen with a security primitive is a second copy that drifts — a fork
 * would give two TTLs, two verification paths, and eventually two different notions of "stale". So
 * the original moves here and both consume it. Bulk-unassign's behaviour is unchanged by the move,
 * pinned by its existing e2e.
 *
 * The payload is generic: each consumer defines the shape it wants to snapshot, and this module owns
 * only the envelope (`iat`/`exp`), the signature, and the constant-time comparison.
 */

/**
 * Preview-token TTL — short enough that a stale click is refused rather than acted on blind, long
 * enough that an operator reading a page carefully is not interrupted. Shared by every consumer on
 * purpose: "how stale is too stale" is one policy, not a per-feature preference.
 */
export const PREVIEW_TOKEN_TTL_SEC = 10 * 60;

/** The envelope this module adds to every payload. */
export interface PreviewTokenEnvelope {
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * Reuses the auth slice's boot-validated HS256 secret (`token.service.ts`) rather than adding a
 * second env var — same trust boundary (a server-only signing secret), different payload shape.
 */
function requirePreviewTokenSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET is not set — refusing to sign a preview token.');
  }
  return secret;
}

/**
 * Sign a snapshot. The result is `<base64url(payload)>.<base64url(hmac)>` — deliberately *not* a JWT:
 * there is no algorithm field to confuse and no third-party parser involved, so the
 * `alg: none` class of mistake is unavailable by construction.
 */
export function signPreviewToken<T extends object>(payload: T, now: Date, ttlSec: number = PREVIEW_TOKEN_TTL_SEC): string {
  const iat = Math.floor(now.getTime() / 1000);
  const full = { ...payload, iat, exp: iat + ttlSec };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = createHmac('sha256', requirePreviewTokenSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify and decode a snapshot. Returns `null` for anything that is not a token this server minted
 * and that is still inside its TTL — a malformed string, a bad signature, an unparseable body, or an
 * expired one. Callers cannot tell those apart on purpose: every one of them means the same thing
 * operationally ("get a fresh preview"), and distinguishing them would tell an attacker which half of
 * a forgery attempt was wrong.
 *
 * The signature comparison is constant-time, and length is checked first because `timingSafeEqual`
 * throws on a length mismatch rather than returning false.
 */
export function verifyPreviewToken<T>(token: string, now: Date): (T & PreviewTokenEnvelope) | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', requirePreviewTokenSecret()).update(body).digest('base64url');
  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let decoded: T & PreviewTokenEnvelope;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  if (typeof decoded.exp !== 'number' || decoded.exp < nowSec) return null;
  return decoded;
}
