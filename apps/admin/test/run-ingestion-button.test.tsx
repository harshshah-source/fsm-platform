import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ToastProvider } from '../src/components/data/Toast';
import { RunIngestionButton } from '../src/pages/dashboard/RunIngestionButton';

/**
 * The OH "Run Ingestion Now" control — an independent manual entry into the existing pipeline
 * (POST /api/integration/run-pipeline), NOT the scheduler. Gated to the backend guard's role
 * (OPERATIONS_HEAD), confirm-before-run, single-fire while in flight, a PipelineSummary on success,
 * an informational notice on a RUN_IN_PROGRESS skip, and a DISTINCT message per failure cause.
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const summary = {
  master: { runId: '11', status: 'SUCCEEDED', stats: { companies: 3 } },
  snapshot: { runId: '22', status: 'SUCCEEDED', chunks: 4, inserted: 360 },
  deviceState: { upserted: 1200 },
  tickets: { created: 0 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderButton(session: SessionView, onSuccess = vi.fn(async () => {})) {
  return {
    onSuccess,
    ...render(
      <AuthProvider initialSession={session}>
        <ToastProvider>
          <RunIngestionButton onSuccess={onSuccess} />
        </ToastProvider>
      </AuthProvider>,
    ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('RunIngestionButton', () => {
  it('does not render for a role the backend guard excludes (ZM)', () => {
    renderButton(zm);
    expect(screen.queryByTestId('run-ingestion-btn')).not.toBeInTheDocument();
  });

  it('renders for an Operations Head', () => {
    renderButton(opsHead);
    expect(screen.getByTestId('run-ingestion-btn')).toBeInTheDocument();
  });

  it('confirms before running, warning about the 3–4 minute VPN run, then POSTs to the trigger endpoint', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => json(summary));
    vi.stubGlobal('fetch', fetchMock);
    renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/master sync/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/3.?4\s*min/i)).toBeInTheDocument();

    // No request until the operator confirms.
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          String(url).includes('/integration/run-pipeline') &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
    });
  });

  it('disables the trigger and shows a running state while the run is in flight (single-fire)', async () => {
    const d = deferred<Response>();
    const fetchMock = vi.fn(() => d.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    const btn = screen.getByTestId('run-ingestion-btn');
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent(/running/i);

    d.resolve(json(summary));
    await waitFor(() => expect(screen.getByTestId('run-ingestion-btn')).toBeEnabled());
  });

  it('on success shows the PipelineSummary (snapshot rows, device states, tickets) and calls onSuccess', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(summary)));
    const { onSuccess } = renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent(/360/); // snapshot rows inserted
    expect(toast).toHaveTextContent(/1200|1,200/); // device states recomputed
    expect(toast).toHaveTextContent(/0 tickets/i); // tickets.created (0 under pgi mode is correct)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('renders a RUN_IN_PROGRESS skip as an informational notice, not an error, and does NOT refetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'RUN_IN_PROGRESS' }, 409)));
    const { onSuccess } = renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent(/already (in progress|running)/i);
    // A skip is not a completed run — no refetch/roll.
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('surfaces the AutoPlant/VPN (503) failure as its own cause, distinct from a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'nope' }, 503)));
    const { onSuccess } = renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent(/autoplant|vpn/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a 401 as a session-expired failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'nope' }, 401)));
    renderButton(opsHead);

    await userEvent.click(screen.getByTestId('run-ingestion-btn'));
    await userEvent.click(screen.getByTestId('run-ingestion-confirm'));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent(/session (has )?expired/i);
  });
});
