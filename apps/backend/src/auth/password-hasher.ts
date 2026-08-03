import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

// Fixed dummy salt hashed on every unknown-email login attempt, so `validateCredentials` costs the
// same wall-clock time whether the email exists or not (Issue #91, 2026-07-28 amendment 1). The value
// itself is not a secret — its only job is to give `scryptAsync` something salt-shaped to chew on.
const DUMMY_SALT = 'a'.repeat(32);

export interface PasswordHash {
  hash: string;
  salt: string;
}

/**
 * Hashes `password` with a fresh random salt using **async** `crypto.scrypt` — never `scryptSync`.
 * The synchronous form blocks the whole Node event loop for the duration of the derivation (tens of
 * milliseconds at default cost params), which turns a login burst (e.g. a shift-start wave of SE
 * logins) into a process-wide stall. This is an explicit amendment preserved from the issue's
 * 2026-07-28 comment, not a style choice.
 */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

/** Constant-time verification of `password` against a stored hash/salt pair. */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const candidate = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * Runs a real scrypt derivation against a fixed dummy salt so an unknown-email login costs
 * approximately the same wall-clock time as a real one — otherwise a fast "no such user" rejection is
 * itself a timing oracle for email enumeration. Mirrors `user-store.ts`'s pre-#91 behavior (which ran
 * `scryptSync` unconditionally before comparing), now async and only invoked on the miss path.
 */
export async function hashDummyPassword(password: string): Promise<void> {
  await scryptAsync(password, DUMMY_SALT, KEYLEN);
}
