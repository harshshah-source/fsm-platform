import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #341 AC3 — **every API client sends `X-Acting-As-Zone` through the one builder.**
 *
 * The backend half of this slice narrows a manager write door by the acting header. That is worth
 * nothing on a route the admin never sends the header to — and three clients
 * (`dispatch-runs.ts`, `install.ts`, `tickets.ts` among them) hand-rolled
 * `headers: token ? { Authorization: … } : {}` and sent no acting header at all. So the operator saw
 * the acting banner, the backend saw an ordinary pan-India CSM, and the two disagreed silently.
 *
 * Pinned structurally rather than per-client for the same reason as the backend sweep: the defect is
 * a *copyable* three-line idiom, and a per-client test only covers the clients that exist today. This
 * fails the moment a new file hand-rolls the header again.
 *
 * `authHeaders()` is the single builder (`src/api/authHeaders.ts`), and it is the only place allowed
 * to read the token key — which is what makes "did this client send the acting header?" a question
 * with one answer rather than one per file.
 */
const API_DIR = join(__dirname, '..', 'src', 'api');

/** A hand-rolled bearer header: the shape `authHeaders()` exists to replace. */
const HAND_ROLLED = /Authorization:\s*`Bearer \$\{/;

/**
 * Files that legitimately build their own Authorization header. Each is a **reason**, not a
 * suppression — widening this list is the deliberate edit the pin exists to force.
 */
const ALLOWED: Record<string, string> = {
  'authHeaders.ts': 'the builder itself',
  'tokens.ts': 'the token store — it owns the storage keys `authHeaders()` reads',
  'client.ts':
    'login and /me — the token is the subject of the request, not an ambient credential, and neither route has a zone to act in',
};

// `http.ts` needs no allowance and deliberately has none. Its `withBearer` replaces only the
// Authorization header on a refresh-retry — `new Headers(init.headers)` carries `X-Acting-As-Zone`
// through untouched — so a retried request is still an acting request. That is the property this
// slice depends on and it is worth stating: an implementation that rebuilt the header set from
// scratch there would silently drop acting on every 401 retry.


/** The token key belongs to the builder and the store; a client that reads it is authenticating alone. */
const TOKEN_KEY = /'fsm\.accessToken'/;

/** A file is an offender if it authenticates by either route — hand-rolled header, or raw token key. */
function offends(file: string): boolean {
  const source = code(readFileSync(join(API_DIR, file), 'utf8'));
  return HAND_ROLLED.test(source) || TOKEN_KEY.test(source);
}

function apiFiles(): string[] {
  return readdirSync(API_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('#341 AC3 — one acting-header builder', () => {
  it('the scan actually saw the api directory', () => {
    expect(apiFiles().length).toBeGreaterThan(10);
  });

  it('every client authenticates through authHeaders(), and none by itself', () => {
    // Both offence shapes, because either one bypasses the acting header: writing the bearer inline,
    // or reading `fsm.accessToken` and building whatever it likes from it. Catching only the first
    // would leave the second as the obvious way round the rule.
    expect(apiFiles().filter((f) => ALLOWED[f] === undefined && offends(f))).toEqual([]);
  });

  it('every allowance still names a file that authenticates on its own', () => {
    // An allowance whose file has since moved to the builder is stale, and would silently cover a
    // later regression in that same file.
    expect(Object.keys(ALLOWED).filter((f) => !offends(f))).toEqual([]);
  });
});
