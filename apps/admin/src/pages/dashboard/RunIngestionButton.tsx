import { useRef, useState } from 'react';
import { apiRunPipeline, RunPipelineError, type PipelineSummary } from '../../api/integration';
import { useAuth } from '../../auth/AuthProvider';
import { useToastOptional } from '../../components/data';
import { Modal } from '../../components/overlay/Modal';
import { Button } from '../../components/ui';

/** The int-formatted summary line the success toast shows the operator. */
function SummaryToast({ summary }: { summary: PipelineSummary }) {
  const nf = new Intl.NumberFormat('en-IN');
  return (
    <div>
      <div className="font-semibold">Ingestion complete</div>
      <div className="mt-0.5 text-xs">
        Masters {summary.master.status.toLowerCase()} · {nf.format(summary.snapshot.inserted)} snapshot rows ·{' '}
        {nf.format(summary.deviceState.upserted)} device states recomputed · {nf.format(summary.tickets.created)}{' '}
        tickets created
      </div>
    </div>
  );
}

/**
 * Operations-Head manual ingestion trigger for the OH dashboard. An INDEPENDENT manual entry into the
 * existing pipeline (`POST /api/integration/run-pipeline`) — it does not touch the dormant scheduler.
 * Gated to OPERATIONS_HEAD (matching the backend guard, not widening it), confirm-before-run, single-fire
 * while in flight. On a completed run it fires `onSuccess` so the dashboard refetches + rolls its KPIs;
 * a RUN_IN_PROGRESS skip is an informational notice, and every real failure gets its own message.
 */
export function RunIngestionButton({ onSuccess }: { onSuccess: () => void | Promise<void> }) {
  const { session } = useAuth();
  const toast = useToastOptional();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  // Match the backend guard exactly — do not widen access.
  if (session?.role !== 'OPERATIONS_HEAD') return null;

  const doRun = async (): Promise<void> => {
    if (runningRef.current) return; // client-side double-fire guard
    runningRef.current = true;
    setRunning(true);
    setConfirmOpen(false);
    try {
      const result = await apiRunPipeline();
      if (result.skipped) {
        toast?.push('A run is already in progress — its results will appear when it finishes.', 'info');
        return;
      }
      toast?.success(<SummaryToast summary={result.summary} />);
      await onSuccess();
    } catch (e) {
      const message =
        e instanceof RunPipelineError ? e.message : 'The ingestion run could not be started.';
      toast?.error(message);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid="run-ingestion-btn"
        loading={running}
        disabled={running}
        onClick={() => setConfirmOpen(true)}
      >
        {running ? 'Running ingestion…' : 'Run Ingestion Now'}
      </Button>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Run ingestion now?"
        footer={
          <>
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              data-testid="run-ingestion-confirm"
              onClick={() => void doRun()}
            >
              Run now
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This runs master sync → snapshot ingest → device-state recompute against AutoPlant. It can take
          3–4 minutes over the VPN. The dashboard refreshes automatically when it completes.
        </p>
      </Modal>
    </>
  );
}
