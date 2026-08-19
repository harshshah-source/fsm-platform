import { PREVIEW_TOKEN_TTL_SEC, signPreviewToken, verifyPreviewToken } from '../src/scheduling/preview-token';

/**
 * #251 — the preview-token module extracted from `bulk-unassign.service.ts` (#179).
 *
 * A security primitive that gets copied is a security primitive that drifts, so the extraction is the
 * point: two copies would eventually mean two TTLs and two notions of "stale". These are unit tests
 * against the module directly — `bulk-unassign-execute.e2e-spec.ts` remains the pin that the
 * *behaviour* did not change when the code moved.
 *
 * Every rejection path returns `null` rather than a reason, deliberately: operationally they all mean
 * "get a fresh preview", and distinguishing them would tell a forger which half they got wrong.
 */
const NOW = new Date('2026-06-21T06:00:00Z');

interface Snapshot {
  targetDate: string;
  countsByZone: Record<string, number>;
}

describe('#251 — preview token', () => {
  const payload: Snapshot = { targetDate: '2026-06-22', countsByZone: { '1': 7, '2': 0 } };

  it('round-trips a payload and stamps the envelope', () => {
    const token = signPreviewToken(payload, NOW);
    const decoded = verifyPreviewToken<Snapshot>(token, NOW);

    expect(decoded).not.toBeNull();
    expect(decoded!.targetDate).toBe('2026-06-22');
    expect(decoded!.countsByZone).toEqual({ '1': 7, '2': 0 });
    expect(decoded!.exp - decoded!.iat).toBe(PREVIEW_TOKEN_TTL_SEC);
  });

  it('rejects a tampered payload — the signature covers the body', () => {
    const token = signPreviewToken(payload, NOW);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...payload, countsByZone: { '1': 999 }, iat: 0, exp: 9_999_999_999 }),
      'utf8',
    ).toString('base64url');

    expect(verifyPreviewToken(`${forged}.${sig}`, NOW)).toBeNull();
    // …and the original body with a mangled signature fails too.
    expect(verifyPreviewToken(`${body}.${'a'.repeat(sig.length)}`, NOW)).toBeNull();
  });

  it('rejects an expired token one second past its TTL', () => {
    const token = signPreviewToken(payload, NOW);
    const justInside = new Date(NOW.getTime() + PREVIEW_TOKEN_TTL_SEC * 1000);
    const justOutside = new Date(NOW.getTime() + (PREVIEW_TOKEN_TTL_SEC + 1) * 1000);

    expect(verifyPreviewToken(token, justInside)).not.toBeNull();
    expect(verifyPreviewToken(token, justOutside)).toBeNull();
  });

  it('rejects structurally invalid input rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so the length check has to come first — a
    // malformed token must be a `null`, never a 500.
    for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.y']) {
      expect(verifyPreviewToken(bad, NOW)).toBeNull();
    }
  });

  it('honours an explicit TTL override', () => {
    const token = signPreviewToken(payload, NOW, 60);
    const decoded = verifyPreviewToken<Snapshot>(token, NOW);
    expect(decoded!.exp - decoded!.iat).toBe(60);
    expect(verifyPreviewToken(token, new Date(NOW.getTime() + 61_000))).toBeNull();
  });
});
