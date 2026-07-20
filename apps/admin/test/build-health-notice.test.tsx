import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { BuildHealthNotice } from '../src/components/BuildHealthNotice';

/**
 * #130 L3/L5 parity — the Operations-Head build-health alert. Warns when a recent pipeline run ran
 * under a stale build, or when the latest recompute's eligibility swung beyond the canary threshold.
 * Warns only, OpsHead-only, and silent when healthy.
 */
type HealthPayload = {
  masterSync: { build: { buildVersion: string | null; buildFingerprint: string | null; staleBuild: boolean } | null };
  snapshot: { build: { buildVersion: string | null; buildFingerprint: string | null; staleBuild: boolean } | null };
  runtimeLock: { version: string | null; fingerprint: string | null };
  recomputes: Array<{ swing: boolean; staleBuild: boolean }>;
};

function stubHealth(payload: HealthPayload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/integration/health')) {
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function renderFor(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <BuildHealthNotice />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const healthy: HealthPayload = {
  masterSync: { build: { buildVersion: '10', buildFingerprint: 'abc', staleBuild: false } },
  snapshot: { build: { buildVersion: '10', buildFingerprint: 'abc', staleBuild: false } },
  runtimeLock: { version: '10', fingerprint: 'abc' },
  recomputes: [{ swing: false, staleBuild: false }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#130 BuildHealthNotice', () => {
  it('warns when a recent pipeline run ran under a stale build', async () => {
    stubHealth({ ...healthy, masterSync: { build: { buildVersion: '5', buildFingerprint: 'old', staleBuild: true } } });
    renderFor(oh);
    const alert = await screen.findByRole('alert', { name: /build health/i });
    expect(alert).toHaveTextContent(/older than the current/i);
  });

  it('warns when the latest recompute eligibility swung beyond the canary threshold', async () => {
    stubHealth({ ...healthy, recomputes: [{ swing: true, staleBuild: false }] });
    renderFor(oh);
    const alert = await screen.findByRole('alert', { name: /build health/i });
    expect(alert).toHaveTextContent(/swung beyond the canary/i);
  });

  it('renders nothing when everything is healthy', async () => {
    stubHealth(healthy);
    renderFor(oh);
    // Give the effect a chance to resolve, then assert no alert.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('never renders for a non-OpsHead role', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderFor(zm);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
