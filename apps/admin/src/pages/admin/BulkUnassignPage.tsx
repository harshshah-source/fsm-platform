import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  executeBulkUnassign,
  listBulkUnassignHistory,
  previewBulkUnassign,
  runDispatch,
  type BulkUnassignHistoryRow,
  type DispatchRunSummary,
  type ExecuteResult,
  type PreviewResult,
} from '../../api/bulkUnassign';
import { getDispatchInFlight, type DispatchInFlight } from '../../api/dispatchSchedule';
import { listZones, type ZoneView } from '../../api/org';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { Modal } from '../../components/overlay';
import { Select } from '../../components/overlay/Select';
import { Button } from '../../components/ui/Button';

/** #179 — verbatim, so nobody presses this expecting a different plan for free. */
const REBALANCE_COPY =
  'With roster, coverage, zones, availability and device states unchanged since the morning run, ' +
  'unassign-then-redispatch reproduces materially the same plan; the net effect is hollowed stops ' +
  'and renumbered plans for every SE in scope. This control pays only when dispatch inputs have ' +
  'changed — fix the data first, then press it.';

/**
 * OH bulk unassign / mid-day rebalance (#179). Two buttons, deliberately separate — Unassign
 * (preview → typed confirm → execute) and Run dispatch — so a partial failure is always legible
 * per action rather than hidden inside one combined call. Imageless (#119 precedent); mirrors the
 * Plant Deactivations page's structure.
 */
export function BulkUnassignPage() {
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [scope, setScope] = useState<'ZONE' | 'PAN_INDIA'>('ZONE');
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [history, setHistory] = useState<BulkUnassignHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<DispatchRunSummary | null>(null);
  const [inFlight, setInFlight] = useState<DispatchInFlight[]>([]);

  const loadHistory = useCallback(() => {
    listBulkUnassignHistory()
      .then(setHistory)
      .catch(() => setError('Failed to load history'));
  }, []);

  /**
   * #213 — poll which zones have a run in flight, so the button can disable itself with the reason
   * shown *before* anyone presses it. Polled rather than fetched once because the run this guards
   * against is usually the 05:00 cron, which starts without the operator doing anything.
   */
  const loadInFlight = useCallback(() => {
    getDispatchInFlight()
      .then(setInFlight)
      .catch(() => setInFlight([])); // a failed probe must not disable a control that may be fine
  }, []);

  useEffect(() => {
    listZones()
      .then(setZones)
      .catch(() => setError('Failed to load zones'));
    loadHistory();
    loadInFlight();
    const poll = setInterval(loadInFlight, 10_000);
    return () => clearInterval(poll);
  }, [loadHistory, loadInFlight]);

  const zoneOptions = useMemo(() => zones.map((z) => ({ value: String(z.zoneId), label: `${z.name} (#${z.zoneId})` })), [zones]);
  const selectedZoneName = zones.find((z) => String(z.zoneId) === zoneId)?.name ?? null;
  const canOpen = (scope === 'PAN_INDIA' || zoneId != null) && reasonCode.trim().length > 0;

  const runDispatchNow = async () => {
    setDispatchBusy(true);
    setError(null);
    try {
      const res = await runDispatch(scope === 'ZONE' && zoneId != null ? Number(zoneId) : undefined, reasonCode);
      // #213 — a run can start between the poll and the click, so the refusal still has to read well
      // here. Show the server's own sentence rather than a generic failure: it names the zone, when the
      // holding run started and who started it.
      if (res.result === 'ALREADY_RUNNING') {
        setError(res.message);
        loadInFlight();
        return;
      }
      setDispatchResult(res.summary);
    } catch {
      setError('Dispatch run failed.');
    } finally {
      setDispatchBusy(false);
    }
  };

  /** The operator-facing sentence for the disabled state — same facts as the server's 409. */
  const inFlightNotice =
    inFlight.length === 0
      ? null
      : `Dispatch already running — ${inFlight
          .map((f) => `zone ${f.zoneId}, started ${new Date(f.startedAt).toLocaleTimeString()} by ${f.actor}`)
          .join('; ')}.`;

  const historyColumns: Column<BulkUnassignHistoryRow>[] = [
    { key: 'scope', header: 'Scope', render: (r) => (r.scope === 'PAN_INDIA' ? 'Pan-India' : (r.zoneName ?? r.zoneId)) },
    { key: 'reason', header: 'Reason', render: (r) => r.reasonCode ?? '—' },
    {
      key: 'result',
      header: 'Result',
      render: (r) => (r.skipped ? <span className="text-critical">Skipped — {r.skipReason}</span> : <span>{r.ticketsUnassigned}</span>),
    },
    { key: 'actor', header: 'By', render: (r) => <span className="text-xs text-ink-subtle">{r.actorId.slice(0, 8)}</span> },
    { key: 'at', header: 'When', render: (r) => new Date(r.createdAt).toLocaleString() },
  ];

  return (
    <section>
      <PageHeader
        title="Bulk Unassign"
        subtitle="Mid-day rebalance: unassign all currently-assigned troubleshoot work for a zone or Pan-India — including work still sitting on older, never-closed day plans — then re-run dispatch so tickets land freshly on engineers."
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="premium-panel mb-6 rounded-card border border-line p-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-subtle">Scope</label>
            <Select
              value={scope}
              onChange={(v) => {
                setScope(v as 'ZONE' | 'PAN_INDIA');
                setZoneId(null);
              }}
              options={[
                { value: 'ZONE', label: 'Zone' },
                { value: 'PAN_INDIA', label: 'Pan-India' },
              ]}
              aria-label="Scope"
            />
          </div>
          {scope === 'ZONE' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-subtle">Zone</label>
              <Select value={zoneId} onChange={setZoneId} options={zoneOptions} placeholder="Select a zone…" aria-label="Zone" />
            </div>
          )}
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-xs font-medium text-ink-subtle">Reason</label>
            <input
              className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
              placeholder="Why is this rebalance happening?"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              data-testid="reason-input"
            />
          </div>
          <Button variant="danger" disabled={!canOpen} onClick={() => setPreviewOpen(true)} data-testid="open-unassign">
            Unassign
          </Button>
          <Button
            variant="secondary"
            loading={dispatchBusy}
            disabled={inFlight.length > 0}
            onClick={runDispatchNow}
            data-testid="run-dispatch"
          >
            Run dispatch
          </Button>
        </div>
        {inFlightNotice && (
          <p className="mt-3 text-xs font-medium text-warning" data-testid="dispatch-in-flight-notice">
            {inFlightNotice}
          </p>
        )}
        <p className="mt-3 text-xs text-ink-muted">{REBALANCE_COPY}</p>
        {dispatchResult && (
          <p className="mt-2 text-xs text-ink-subtle" data-testid="dispatch-result">
            Dispatch run: {dispatchResult.zones} zone(s), {dispatchResult.schedules} schedule(s), {dispatchResult.tickets} ticket(s) dispatched.
          </p>
        )}
      </div>

      <DataTable
        columns={historyColumns}
        rows={history}
        rowKey={(r) => r.id}
        rowTestId={(r) => `history-${r.id}`}
        ariaLabel="Bulk unassign history"
        empty={<EmptyState message="No bulk unassign runs yet." />}
      />

      {previewOpen && (
        <PreviewDialog
          scope={scope}
          zoneId={zoneId}
          zoneName={selectedZoneName}
          reasonCode={reasonCode}
          onClose={() => setPreviewOpen(false)}
          onExecuted={loadHistory}
        />
      )}
    </section>
  );
}

function PreviewDialog({
  scope,
  zoneId,
  zoneName,
  reasonCode,
  onClose,
  onExecuted,
}: {
  scope: 'ZONE' | 'PAN_INDIA';
  zoneId: string | null;
  zoneName: string | null;
  reasonCode: string;
  onClose: () => void;
  /** Fired once execute succeeds — refreshes the history list. Does NOT close the dialog; the OH
   *  reviews the per-zone result (including any lock-skipped zone) and closes it themselves. */
  onExecuted: () => void;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  useEffect(() => {
    previewBulkUnassign({ scope, zoneId: zoneId != null ? Number(zoneId) : undefined, reasonCode })
      .then(setPreview)
      .catch(() => setErr('Preview failed — please close and try again.'));
  }, [scope, zoneId, reasonCode]);

  const expectedConfirm = scope === 'PAN_INDIA' ? 'PAN INDIA' : (zoneName ?? '');

  const confirm = async () => {
    if (confirmText.trim().toLowerCase() !== expectedConfirm.trim().toLowerCase()) {
      setErr(scope === 'PAN_INDIA' ? 'Type "PAN INDIA" to confirm.' : `Type the zone name ("${expectedConfirm}") to confirm.`);
      return;
    }
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      const outcome = await executeBulkUnassign({
        scope,
        zoneId: zoneId != null ? Number(zoneId) : undefined,
        reasonCode,
        previewToken: preview.previewToken,
      });
      if (outcome.result === 'TOKEN_STALE') {
        setPreview(outcome.freshPreview);
        setErr('Counts changed since the preview was opened — re-check and confirm again.');
        setBusy(false);
        return;
      }
      if (outcome.result === 'TOKEN_REQUIRED' || outcome.result === 'TOKEN_INVALID') {
        setErr('Preview expired — close and re-open Unassign.');
        setBusy(false);
        return;
      }
      setResult(outcome);
      onExecuted();
    } catch {
      setErr('Unassign failed — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={scope === 'PAN_INDIA' ? 'Unassign — Pan-India' : `Unassign — ${zoneName ?? ''}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button variant="danger" loading={busy} disabled={!preview} onClick={confirm} data-testid="confirm-unassign">
              Confirm unassign
            </Button>
          )}
        </div>
      }
    >
      {!preview && !err && <p className="text-sm text-ink-muted">Loading preview…</p>}

      {preview && !result && (
        <>
          <ul className="space-y-3 text-sm">
            {preview.zones.map((z) => (
              <li key={z.zoneId} data-testid={`preview-zone-${z.zoneId}`}>
                <p className="font-semibold text-ink-strong">{z.zoneName}</p>
                <p>
                  {z.counts.eligible} eligible · {z.counts.onSite} on-site · {z.counts.componentBlocked} waiting on parts
                </p>
                <p className="text-xs text-ink-muted">
                  Excluded: {z.counts.closedExcluded} closed · {z.counts.installRecoveryExcluded} install/recovery ·{' '}
                  {z.counts.deferredExcluded} deferred
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-muted">{REBALANCE_COPY}</p>
          <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle">
            Type {scope === 'PAN_INDIA' ? '"PAN INDIA"' : `the zone name ("${expectedConfirm}")`} to confirm
          </label>
          <input
            className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            data-testid="confirm-text"
          />
        </>
      )}

      {result && result.result === 'OK' && (
        <ul className="space-y-1 text-sm">
          {result.zones.map((z) => (
            <li key={z.zoneId} data-testid={`unassign-result-${z.zoneId}`}>
              {z.zoneName}: {z.skipped ? `Skipped — ${z.skipReason}` : `${z.ticketsUnassigned} unassigned`}
            </li>
          ))}
        </ul>
      )}

      {err && (
        <p className="mt-2 text-sm text-critical" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}
