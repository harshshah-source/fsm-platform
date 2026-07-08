// Typed client for the Operations-Head manual ingestion trigger (`POST /api/integration/run-pipeline`,
// Issue 97). This is an independent manual entry into the SAME pipeline the (deliberately dormant)
// scheduler drives — it does not touch the scheduler. The backend guards the route to OPERATIONS_HEAD,
// returns the PipelineSummary on success, 409 { code: RUN_IN_PROGRESS } when a run is already in flight,
// and 503 when AutoPlant/VPN is unreachable. This client folds the 409 into an informational skip and
// maps every other failure to a distinct, user-actionable cause.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** Mirrors the backend `PipelineSummary` (integration-sync.service.ts). */
export interface PipelineSummary {
  master: { runId: string; status: string; stats: Record<string, unknown> };
  snapshot: { runId: string; status: string; chunks: number; inserted: number };
  deviceState: { upserted: number };
  tickets: { created: number };
}

export type RunPipelineResult =
  | { skipped: false; summary: PipelineSummary }
  | { skipped: true; reason: 'RUN_IN_PROGRESS' };

/** The distinguishable failure causes the button surfaces separately (never one generic "failed"). */
export type RunPipelineErrorKind = 'UNCONFIGURED' | 'UNAUTHORIZED' | 'SERVER' | 'NETWORK' | 'UNKNOWN';

export class RunPipelineError extends Error {
  constructor(
    readonly kind: RunPipelineErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RunPipelineError';
  }
}

const MESSAGES: Record<RunPipelineErrorKind, string> = {
  UNCONFIGURED:
    'AutoPlant is unreachable — connect to the VPN and confirm the source is configured, then retry.',
  UNAUTHORIZED: 'Your session has expired. Sign in again to run the ingestion pipeline.',
  SERVER: 'The ingestion run failed on the server. Check the backend logs and retry.',
  NETWORK: 'Could not reach the server. Check your connection (or the VPN) and retry.',
  UNKNOWN: 'The ingestion run could not be started.',
};

export async function apiRunPipeline(): Promise<RunPipelineResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/integration/run-pipeline`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    });
  } catch {
    throw new RunPipelineError('NETWORK', MESSAGES.NETWORK);
  }

  if (res.ok) {
    return { skipped: false, summary: (await res.json()) as PipelineSummary };
  }

  const body = (await res.json().catch(() => null)) as { code?: string } | null;

  // A run already in flight is a normal outcome, surfaced as an informational notice — not an error.
  if (res.status === 409 || body?.code === 'RUN_IN_PROGRESS') {
    return { skipped: true, reason: 'RUN_IN_PROGRESS' };
  }
  if (res.status === 503) throw new RunPipelineError('UNCONFIGURED', MESSAGES.UNCONFIGURED, 503);
  if (res.status === 401 || res.status === 403)
    throw new RunPipelineError('UNAUTHORIZED', MESSAGES.UNAUTHORIZED, res.status);
  if (res.status >= 500) throw new RunPipelineError('SERVER', MESSAGES.SERVER, res.status);
  throw new RunPipelineError('UNKNOWN', `${MESSAGES.UNKNOWN} (HTTP ${res.status})`, res.status);
}
