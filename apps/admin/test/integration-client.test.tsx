import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRunPipeline, RunPipelineError } from '../src/api/integration';

/**
 * Client for the OH manual ingestion trigger (POST /api/integration/run-pipeline). It must:
 *  - return the PipelineSummary on 200,
 *  - fold the backend's 409 { code: RUN_IN_PROGRESS } into an informational "skipped" result (not an error),
 *  - and surface every real failure as a DISTINCT cause (VPN/AutoPlant down, session expired, server, network).
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const summary = {
  master: { runId: '11', status: 'SUCCEEDED', stats: { companies: 3 } },
  snapshot: { runId: '22', status: 'SUCCEEDED', chunks: 4, inserted: 360 },
  deviceState: { upserted: 1200 },
  tickets: { created: 0 },
};

describe('apiRunPipeline', () => {
  it('POSTs to /integration/run-pipeline with the bearer token and returns the summary', async () => {
    sessionStorage.setItem('fsm.accessToken', 'tok-1');
    const fetchMock = vi.fn(async (..._args: unknown[]) => json(summary));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiRunPipeline();

    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/integration/run-pipeline');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(res).toEqual({ skipped: false, summary });
  });

  it('treats 409 RUN_IN_PROGRESS as an informational skip, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'RUN_IN_PROGRESS', message: 'busy' }, 409)));
    await expect(apiRunPipeline()).resolves.toEqual({ skipped: true, reason: 'RUN_IN_PROGRESS' });
  });

  it('maps 503 to an UNCONFIGURED (AutoPlant/VPN) cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'not configured' }, 503)));
    await expect(apiRunPipeline()).rejects.toMatchObject({ kind: 'UNCONFIGURED' });
  });

  it('maps 401 to a session-expired cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'unauth' }, 401)));
    await expect(apiRunPipeline()).rejects.toMatchObject({ kind: 'UNAUTHORIZED' });
  });

  it('maps 5xx to a distinct SERVER cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'boom' }, 500)));
    await expect(apiRunPipeline()).rejects.toMatchObject({ kind: 'SERVER' });
  });

  it('maps a fetch rejection (offline/VPN drop) to a NETWORK cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await apiRunPipeline().catch((e) => e);
    expect(err).toBeInstanceOf(RunPipelineError);
    expect(err.kind).toBe('NETWORK');
  });
});
