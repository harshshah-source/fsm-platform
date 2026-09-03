import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiDeescalate,
  apiEscalateVerification,
  apiFraudFlags,
  apiMarkAutoRecovery,
  apiVerificationReview,
  type FraudFlagRow,
  type VerificationReviewRow,
} from '../../api/verification';
import { MetricStrip } from '../../components/data/MetricStrip';
import { PageHeader } from '../../components/data/PageHeader';
import { ChartCard } from '../../components/charts/ChartCard';
import { ChartLegend, DonutChart } from '../../components/charts/DonutChart';
import { CHART } from '../../components/charts/colors';
import { Tab, TabList, TabPanel, Tabs } from '../../components/overlay/Tabs';

/**
 * GPS Verification Review (Issue 19, `/verification`). The ZM-facing follow-up surface over Issue 18's
 * verification_runs: zone-scoped (server-side), filterable by outcome / company / date, defaulting to
 * all non-CLOSED newest-first. Each row renders by type — PARTIAL_RECOVERY (ping count + 24 h
 * countdown), FAILED_VERIFICATION split into no-pings vs a fraud-flag distance chip, CLOSED (green).
 * Fraud rows get an Escalate action (mandatory reason); recoverable rows get Mark CLOSED_AUTO_RECOVERY.
 * Clicking a row opens the Ticket Detail Drawer at the Verification tab.
 *
 * #358 finishes it against the backend #357 landed, on three fronts:
 *
 * 1. **The fraud queue is a queue again.** `GET /verification/fraud-flags` became zone-scoped and
 *    nothing on the client called it, so the one list a ZM works fraud from did not exist in the UI.
 *    It is a tab of its own fed by that endpoint — not a filter over the review rows, which would
 *    silently drop every flagged ticket the review filters exclude.
 * 2. **"Overdue" is no longer said about a window nobody is late for.** The sweep will not expire a
 *    window while telemetry has not advanced past it (#148), so its countdown runs past zero forever.
 *    "Overdue" tells the reviewer the ENGINEER missed a deadline; the truth is the INGESTION pipeline
 *    did, and those are opposite actions — chase the SE, or chase the pipeline. Stalled rows say so,
 *    with the watermark they are stuck behind.
 * 3. **Both verdict-overriding doors take a reason and a confirm**, and ESCALATED has a way back.
 */
const OUTCOME_FILTERS = [
  { value: '', label: 'All non-CLOSED' },
  { value: 'PARTIAL_RECOVERY', label: 'Partial recovery' },
  { value: 'FAILED_VERIFICATION', label: 'Failed verification' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'CLOSED_AUTO_RECOVERY', label: 'Auto-recovery' },
];

function hoursLeft(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return 'overdue';
  return `${Math.floor(ms / 3_600_000)}h left`;
}

/** Watermark stamp, in the reader's locale — the "DATA AS OF …" the reference puts in the context bar. */
function stamp(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

/**
 * The countdown cell for an in-flight window. A stalled window has no honest countdown to print, at
 * any point in its life: the clock is not what decides it, so the watermark is shown instead of a
 * number that cannot come true.
 */
function Countdown({ row }: { row: Pick<VerificationReviewRow, 'stalled' | 'telemetryAsOf' | 'partialDeadline'> }) {
  if (row.stalled) {
    return (
      <span className="rounded bg-neutral-bg px-1.5 py-0.5 text-[11px] font-medium text-ink">
        stalled — telemetry as of {stamp(row.telemetryAsOf)}
      </span>
    );
  }
  const left = hoursLeft(row.partialDeadline);
  return left ? <span>{left}</span> : null;
}

/** #358 — the one predicate for "may this be reversed", matching the door's own 409 guard. */
const isEscalated = (r: { ticketStatus: string }): boolean => r.ticketStatus === 'ESCALATED';

type ActionKind = 'escalate' | 'autoRecovery' | 'deescalate';

/** The row a destructive action is being captured for, and whether it has reached the confirm step. */
interface PendingAction {
  kind: ActionKind;
  ticketId: string;
  deviceId: string;
  confirming: boolean;
}

/**
 * All three verdict-overriding doors take the SAME capture — reason, then confirm — because they are
 * the same kind of decision: a human overruling, or reversing, what the platform concluded about
 * whether the work happened. #357 made the reason mandatory server-side on each; the confirm is #358's
 * AC3, and it is the half that matters on a table where every action button sits one stray click from
 * a row the reviewer was only reading.
 */
const ACTION: Record<ActionKind, {
  verb: string;
  dialogLabel: string;
  reasonLabel: string;
  prompt: (device: string) => string;
  confirmPrompt: (device: string) => string;
  tone: string;
}> = {
  escalate: {
    verb: 'Escalate',
    dialogLabel: 'Escalate verification',
    reasonLabel: 'Escalation reason',
    prompt: (d) => `Escalate fraud-flagged ticket ${d} — reason required`,
    confirmPrompt: (d) => `Escalate ${d} for fraud review? The ticket leaves the verification queue.`,
    tone: 'bg-orange-600 text-white',
  },
  autoRecovery: {
    verb: 'Mark auto-recovery',
    dialogLabel: 'Mark auto-recovery',
    reasonLabel: 'Auto-recovery reason',
    prompt: (d) => `Mark ${d} CLOSED_AUTO_RECOVERY — reason required`,
    confirmPrompt: (d) => `Close ${d} as CLOSED_AUTO_RECOVERY? This overrides the platform's verification verdict.`,
    tone: 'bg-ink text-white',
  },
  deescalate: {
    verb: 'De-escalate',
    dialogLabel: 'De-escalate verification',
    reasonLabel: 'De-escalation reason',
    prompt: (d) => `Reverse the escalation on ${d} — reason required`,
    confirmPrompt: (d) => `Return ${d} to the state it was escalated from? The escalation reason is cleared.`,
    tone: 'bg-brand-600 text-white',
  },
};

export function VerificationReviewPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<VerificationReviewRow[]>([]);
  const [flags, setFlags] = useState<FraudFlagRow[]>([]);
  const [tab, setTab] = useState<'review' | 'fraud'>('review');
  const [outcome, setOutcome] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** One capture panel for all three doors — only one is ever open, so one piece of state. */
  const [action, setAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');

  const filters = useMemo(
    () => ({ outcome: outcome || undefined, companyId: companyId || undefined }),
    [outcome, companyId],
  );

  // Outcome breakdown of the rows currently in view — feeds the KPI strip + donut (FE-05).
  const counts = useMemo(() => {
    const c = { partial: 0, fraud: 0, noPings: 0, closed: 0, auto: 0, pending: 0, stalled: 0 };
    for (const r of rows) {
      if (r.rowType === 'PARTIAL_RECOVERY') c.partial++;
      else if (r.rowType === 'FAILED_FRAUD') c.fraud++;
      else if (r.rowType === 'FAILED_NO_PINGS') c.noPings++;
      else if (r.rowType === 'CLOSED') c.closed++;
      else if (r.rowType === 'CLOSED_AUTO_RECOVERY') c.auto++;
      else c.pending++;
      if (r.stalled) c.stalled++;
    }
    return c;
  }, [rows]);

  /** Global watermark — identical on every row, so the first row that carries one speaks for the page. */
  const telemetryAsOf = useMemo(() => rows.find((r) => r.telemetryAsOf)?.telemetryAsOf ?? null, [rows]);

  const donutData = useMemo(
    () => [
      { name: 'Partial recovery', value: counts.partial, color: CHART.warning },
      { name: 'Failed — fraud', value: counts.fraud, color: CHART.critical },
      { name: 'Failed — no pings', value: counts.noPings, color: CHART.criticalDeep },
      { name: 'Closed / auto', value: counts.closed + counts.auto, color: CHART.success },
      { name: 'Pending', value: counts.pending, color: CHART.neutral },
    ],
    [counts],
  );

  const loadFlags = useCallback(() => {
    apiFraudFlags()
      .then(setFlags)
      .catch(() => setError('Failed to load fraud flags'));
  }, []);

  const refetch = useCallback(() => {
    apiVerificationReview(filters)
      .then(setRows)
      .catch(() => setError('Failed to load verification review'));
    loadFlags();
  }, [filters, loadFlags]);

  useEffect(() => {
    let alive = true;
    apiVerificationReview(filters)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load verification review'));
    return () => {
      alive = false;
    };
  }, [filters]);

  // The fraud queue is its own scoped read (#357), not a slice of the rows above — so it is fetched
  // once on mount rather than when the tab opens, which is what lets the tab carry a live count.
  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  const openAction = useCallback((kind: ActionKind, r: { ticketId: string; deviceId: string }) => {
    setAction({ kind, ticketId: r.ticketId, deviceId: r.deviceId, confirming: false });
    setReason('');
  }, []);

  async function submitAction() {
    if (!action || !reason.trim()) return;
    const { kind, ticketId } = action;
    try {
      if (kind === 'escalate') await apiEscalateVerification(ticketId, reason.trim());
      else if (kind === 'autoRecovery') await apiMarkAutoRecovery(ticketId, reason.trim());
      else await apiDeescalate(ticketId, reason.trim());
      setAction(null);
      setReason('');
      refetch();
    } catch {
      setError(`${ACTION[kind].verb} failed`);
    }
  }

  return (
    <div>
      <PageHeader
        title="GPS Verification Review"
        subtitle="Outcomes for submitted Troubleshoot tickets in your zone. Default shows everything still needing attention (non-closed)."
      />

      {/*
        The reference's context bar carries a DATA AS OF stamp and a snapshot-freshness banner, and
        this page is exactly where that matters: every countdown below is only as trustworthy as the
        watermark it is measured against. When windows are stalled the banner names how many, so the
        reviewer reads "the pipeline is stuck" once, at the top, instead of inferring it row by row.
      */}
      <div
        role="status"
        className={
          counts.stalled > 0
            ? 'mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900'
            : 'mb-4 rounded border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-muted'
        }
      >
        {counts.stalled > 0 ? (
          <>
            Telemetry stalled — data as of {stamp(telemetryAsOf)}. {counts.stalled} window
            {counts.stalled === 1 ? '' : 's'} cannot reach a verdict until ingestion advances; they are
            not overdue submissions.
          </>
        ) : (
          <>Telemetry data as of {stamp(telemetryAsOf)} — verification evidence reflects the latest successful pull.</>
        )}
      </div>

      <MetricStrip
        cols={5}
        metrics={[
          { label: 'In Review', value: rows.length, tone: 'brand' },
          { label: 'Partial Recovery', value: counts.partial, tone: 'warning' },
          { label: 'Failed', value: counts.fraud + counts.noPings, tone: 'critical' },
          { label: 'Fraud Flagged', value: flags.length, tone: 'critical' },
          { label: 'Closed / Auto', value: counts.closed + counts.auto, tone: 'success' },
        ]}
      />

      <ChartCard title="Verification outcomes" className="mb-5">
        <div className="grid items-center gap-6 sm:grid-cols-[240px_1fr]">
          <DonutChart
            data={donutData}
            height={200}
            center={
              <div className="text-center">
                <div className="text-2xl font-bold text-ink-strong">{rows.length}</div>
                <div className="text-[11px] text-ink-muted">Total</div>
              </div>
            }
          />
          {/* Shares in the legend, not just counts — the donut shows the mix but cannot be read to a
              number, and this panel is entirely about proportion of outcomes. */}
          <ChartLegend items={donutData} showShare />
        </div>
      </ChartCard>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'review' | 'fraud')} className="mb-4">
        <TabList aria-label="Verification queues">
          <Tab value="review">Verification queue</Tab>
          <Tab value="fraud">Fraud flagged ({flags.length})</Tab>
        </TabList>

        <TabPanel value="review" className="pt-4">
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <label htmlFor="vr-outcome" className="text-slate-600">
              Outcome
            </label>
            <select
              id="vr-outcome"
              aria-label="Outcome filter"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="rounded border px-2 py-1"
            >
              {OUTCOME_FILTERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Company filter"
              placeholder="Company id"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="w-28 rounded border px-2 py-1"
            />
          </div>

          <table aria-label="Verification review" className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="py-2 pr-3">Company</th>
                <th className="py-2 pr-3">Zone</th>
                <th className="py-2 pr-3">Device</th>
                <th className="py-2 pr-3">Outcome</th>
                <th className="py-2 pr-3">Flags</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-slate-400">
                    No verification rows.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.ticketId}
                  data-testid={`vr-row-${r.ticketId}`}
                  onClick={() => navigate(`/tickets/${r.ticketId}?tab=Verification`)}
                  className="cursor-pointer border-b border-line hover:bg-row-hover"
                >
                  <td className="py-2 pr-3">{r.companyName}</td>
                  <td className="py-2 pr-3 text-slate-600">{r.zoneName}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.deviceId}</td>
                  <td className="py-2 pr-3">
                    <OutcomeCell row={r} />
                  </td>
                  <td className="py-2 pr-3">
                    {isEscalated(r) && <EscalatedChip reason={r.escalationReason} />}
                  </td>
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1">
                      {/* Escalating an already-ESCALATED ticket is a 409 the reviewer should never be
                          offered; the way out of that state is De-escalate, beside it. */}
                      {r.rowType === 'FAILED_FRAUD' && !isEscalated(r) && (
                        <ActionButton kind="escalate" onClick={() => openAction('escalate', r)} />
                      )}
                      {(r.rowType === 'PARTIAL_RECOVERY' || r.rowType === 'FAILED_NO_PINGS') && (
                        <ActionButton kind="autoRecovery" onClick={() => openAction('autoRecovery', r)} />
                      )}
                      {isEscalated(r) && (
                        <ActionButton kind="deescalate" onClick={() => openAction('deescalate', r)} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TabPanel>

        <TabPanel value="fraud" className="pt-4">
          <p className="mb-3 text-xs text-ink-muted">
            Phase-1 location-mismatch flags for your zone, from the scoped fraud-flags read — the full
            flagged set, including tickets the outcome filters above exclude.
          </p>
          <table aria-label="Fraud flagged" className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="py-2 pr-3">Device</th>
                <th className="py-2 pr-3">Zone</th>
                <th className="py-2 pr-3">Distance</th>
                <th className="py-2 pr-3">Concluded</th>
                <th className="py-2 pr-3">Flags</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {flags.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-slate-400">
                    No fraud flags in your zone.
                  </td>
                </tr>
              )}
              {flags.map((f) => (
                <tr
                  key={f.ticketId}
                  data-testid={`vf-row-${f.ticketId}`}
                  onClick={() => navigate(`/tickets/${f.ticketId}?tab=Verification`)}
                  className="cursor-pointer border-b border-line hover:bg-row-hover"
                >
                  <td className="py-2 pr-3 font-mono text-xs">{f.deviceId}</td>
                  <td className="py-2 pr-3 text-slate-600">{f.zoneName}</td>
                  <td className="py-2 pr-3">
                    <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
                      {f.firstPingDistanceMeters != null
                        ? `${Math.round(f.firstPingDistanceMeters)} m off`
                        : 'location mismatch'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-muted">{f.outcomeAt ? stamp(f.outcomeAt) : 'in flight'}</td>
                  <td className="py-2 pr-3">
                    {isEscalated(f) && <EscalatedChip reason={f.escalationReason} />}
                  </td>
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1">
                      {!isEscalated(f) && <ActionButton kind="escalate" onClick={() => openAction('escalate', f)} />}
                      {isEscalated(f) && <ActionButton kind="deescalate" onClick={() => openAction('deescalate', f)} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TabPanel>
      </Tabs>

      {action && (
        <ReasonConfirmPanel
          action={action}
          reason={reason}
          onReason={setReason}
          onAdvance={() => setAction({ ...action, confirming: true })}
          onBack={() => setAction({ ...action, confirming: false })}
          onCancel={() => setAction(null)}
          onConfirm={() => void submitAction()}
        />
      )}
    </div>
  );
}

/** #357's live escalation verdict, rendered where the reference puts its FLAGS column. */
function EscalatedChip({ reason }: { reason: string | null }) {
  return (
    <span
      title={reason ?? undefined}
      className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900"
    >
      ESCALATED
    </span>
  );
}

function ActionButton({ kind, onClick }: { kind: ActionKind; onClick: () => void }) {
  const style =
    kind === 'escalate'
      ? 'bg-orange-600 text-white hover:bg-orange-700'
      : 'border border-line text-ink hover:bg-surface-sunken';
  return (
    <button type="button" onClick={onClick} className={`rounded px-2 py-0.5 text-xs ${style}`}>
      {ACTION[kind].verb}
    </button>
  );
}

/**
 * Reason, then confirm — one panel for all three doors (#358 AC3). The two steps are deliberately
 * separate presses on separate labels: the reason box alone still fires an irreversible override on a
 * single click, and a confirm that reads "Confirm mark auto-recovery" says what is about to happen at
 * the moment it happens, which a button pressed while typing does not.
 */
function ReasonConfirmPanel({
  action,
  reason,
  onReason,
  onAdvance,
  onBack,
  onCancel,
  onConfirm,
}: {
  action: PendingAction;
  reason: string;
  onReason: (v: string) => void;
  onAdvance: () => void;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = ACTION[action.kind];
  return (
    <div role="dialog" aria-label={copy.dialogLabel} className="mt-4 rounded border bg-surface-sunken p-3 text-sm">
      {action.confirming ? (
        <>
          <p className="mb-2 font-medium text-ink">{copy.confirmPrompt(action.deviceId)}</p>
          <p className="mb-2 text-xs text-ink-muted">Reason: {reason.trim()}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className={`rounded px-3 py-1 text-xs ${copy.tone}`}
            >
              Confirm {copy.verb.toLowerCase()}
            </button>
            <button type="button" onClick={onBack} className="rounded border px-3 py-1 text-xs">
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 font-medium text-ink">{copy.prompt(action.deviceId)}</p>
          <textarea
            aria-label={copy.reasonLabel}
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            className="mb-2 w-full rounded border px-2 py-1"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={onAdvance}
              className={`rounded px-3 py-1 text-xs disabled:opacity-40 ${copy.tone}`}
            >
              {copy.verb}
            </button>
            <button type="button" onClick={onCancel} className="rounded border px-3 py-1 text-xs">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function OutcomeCell({ row }: { row: VerificationReviewRow }) {
  switch (row.rowType) {
    case 'PARTIAL_RECOVERY':
      return (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
          Partial recovery · {row.pingsReceivedCount}/3 pings · <Countdown row={row} />
        </span>
      );
    case 'FAILED_FRAUD':
      return (
        <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
          Failed — fraud · {row.firstPingDistanceMeters != null ? `${Math.round(row.firstPingDistanceMeters)} m off` : 'location mismatch'}
        </span>
      );
    case 'FAILED_NO_PINGS':
      return <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Failed — no pings</span>;
    case 'CLOSED':
      return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Closed</span>;
    case 'CLOSED_AUTO_RECOVERY':
      return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Auto-recovery</span>;
    default:
      // A PENDING window that cannot conclude is the case #148 opened and #358 surfaces: it is not
      // "pending" in any sense the reviewer can act on until telemetry moves.
      return (
        <span className="rounded bg-neutral-bg px-2 py-0.5 text-xs text-neutral">
          Pending{row.stalled && <> · <Countdown row={row} /></>}
        </span>
      );
  }
}
