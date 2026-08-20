import { describe, expect, it, vi } from 'vitest';
import { apiLogin } from '../../src/api/client';

/**
 * #107 N3 — the admin→backend HTTP seam, unmocked.
 *
 * Every other admin test mocks `fetch`. That is right for component behaviour and useless for the one
 * question this file exists to answer: **does the admin's own client code actually talk to the real
 * backend?** A mocked test agrees with whatever shape the test author imagined, so a backend that
 * renames a field, changes a status code, moves a route under `/api/v1`, or tightens CORS stays green
 * on both sides and breaks only in a browser.
 *
 * This spec is deliberately **excluded from `pnpm test`** (see `vitest.seam.config.ts`) because it
 * requires a running backend — a suite that fails when you have not started one trains people to
 * ignore it. It runs as its own CI step, which boots the backend first. `SEAM_API_URL` points at it;
 * the client itself reads `VITE_API_URL`, which that step sets to the same value.
 *
 * Scope is deliberately thin: the seam, not the API surface. One authenticated round trip proves the
 * base URL, the route prefix, the JSON contract, the status-code mapping and the shared `@fsm/shared`
 * types all line up end to end. Breadth belongs in the backend e2e suite, which already has it.
 */
/**
 * Deliberately the SAME expression `src/api/client.ts` uses for its own base URL, not a parallel
 * `SEAM_API_URL`. An earlier draft had the two diverge, and the suite passed while the client talked to
 * a stale server on the default port and the raw fetches below talked to the one under test — a seam
 * test measuring two different backends and reporting green. Deriving both from one expression makes
 * that unconstructible.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';

describe('#107 N3 — admin → backend over real HTTP', () => {
  it('the backend under test is actually up (a skipped seam test proves nothing)', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
  });

  it('VITE_API_URL is set — otherwise this suite silently measures whatever is on the default port', () => {
    // CI sets it. Locally, forgetting to set it is the failure mode that produced a green run against
    // the wrong server, so it is an assertion rather than a fallback.
    expect(import.meta.env.VITE_API_URL, 'set VITE_API_URL to the backend under test').toBeTruthy();
  });

  it('apiLogin round-trips a real credential and returns the shared LoginResponse shape', async () => {
    const out = await apiLogin({ email: 'zm.north@fsm.test', password: 'correct-password' });

    // The fields the admin actually stores and sends back — asserted through the client, so a rename
    // on either side of the seam fails here rather than in a browser.
    // The shared contract is exactly { accessToken, refreshToken } (packages/shared LoginResponse) —
    // asserted against the real response, so a field added or renamed on either side fails here.
    expect(Object.keys(out).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(typeof out.accessToken).toBe('string');
    expect(out.accessToken.length).toBeGreaterThan(20);
    expect(typeof out.refreshToken).toBe('string');

    // And the token the backend minted is accepted by the backend on a guarded route — i.e. the two
    // halves of the seam agree about the Authorization header, not just about the login payload.
    // `GET /api/me` is guarded and exists for every role, so the ONLY interesting outcome is 401:
    // that would mean the header the client sends is not the one the guard reads.
    const me = await fetch(`${BASE}/me`, { headers: { Authorization: `Bearer ${out.accessToken}` } });
    expect(me.status).not.toBe(401);
    expect(me.status).not.toBe(404); // …and the route really is there, so the check above is not vacuous
  });

  it('maps a rejected credential to INVALID_CREDENTIALS, not to SERVICE_UNAVAILABLE', async () => {
    // The distinction the client exists to make (client.ts:6) — and it is only true if the backend
    // really answers 401 here. A mocked test asserts the mapping; this asserts the premise.
    await expect(apiLogin({ email: 'zm.north@fsm.test', password: 'wrong-password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('maps an unreachable backend to SERVICE_UNAVAILABLE', async () => {
    // Port 1 is reserved and never listening; this pins the other half of the mapping against a real
    // network refusal rather than a thrown mock.
    // `vi.stubEnv`, not a direct assignment: `import.meta.env` is readonly to TypeScript, so assigning
    // to it compiles under vitest (esbuild strips types) and fails `tsc -b` — which is the admin build.
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:1/api');
    try {
      // Re-imported so the module re-reads BASE_URL. Asserted on `.code`, not `instanceof`: the fresh
      // import carries its OWN LoginError class, so an identity check would fail for a reason that has
      // nothing to do with the seam.
      const { apiLogin: freshLogin } = await import(`../../src/api/client?seam=${Date.now()}`);
      await expect(
        (freshLogin as typeof apiLogin)({ email: 'zm.north@fsm.test', password: 'correct-password' }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
