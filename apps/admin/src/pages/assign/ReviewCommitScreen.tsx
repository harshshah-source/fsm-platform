import { useState } from 'react';
import {
  apiAssignTicket,
  DeferralConflictError,
  type AssignBatchLaneResult,
  type DeferralConflict,
} from '../../api/schedules';
import { DeferralConfirm } from '../../components/domain';
import { Badge, Button } from '../../components/ui';
import { isOverCapacity } from '../../lib/capacity';
import { formatPlantDisplayName } from '../../lib/plantNames';
import type { LaneCoverageFact } from './LaneCoverage';

/**
 * #275 AC — a deferred ticket the batch skipped is not a dead end: `assign-batch` never carries a
 * confirm for a hold (that decision is per-ticket, not per-plan), so resolving one goes through the
 * exact single-ticket confirm flow every other manual-assign surface already uses (#249). Resolving
 * here does not touch the rest of the lane, which is already committed or already reported.
 */
function ResolveHeldTicket({ ticketId, seId, onResolved }: { ticketId: string; seId: string; onResolved: () => void }) {
  const [conflict, setConflict] = useState<DeferralConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const attempt = async (deferral?: { confirm?: boolean; reasonCode?: string }) => {
    setBusy(true);
    setFailed(false);
    try {
      await apiAssignTicket(ticketId, seId, deferral);
      setConflict(null);
      setDone(true);
      onResolved();
    } catch (e) {
      if (e instanceof DeferralConflictError) {
        setConflict(e.conflict);
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) return <span className="text-success">resolved</span>;

  return (
    <span className="inline-block">
      {conflict ? (
        <DeferralConfirm
          conflict={conflict}
          busy={busy}
          onConfirm={(reasonCode) => void attempt({ confirm: true, reasonCode })}
          onCancel={() => setConflict(null)}
        />
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} loading={busy} onClick={() => void attempt()}>
          Resolve hold
        </Button>
      )}
      {failed && <span className="ml-1 text-critical">could not resolve — try again</span>}
    </span>
  );
}

/** One lane, resolved and ready for the diff — plants turned into the ticket ids the commit will move. */
export interface ReviewLane {
  seId: string;
  engineerName: string;
  plantNames: string[];
  ticketIds: string[];
  criticalCount: number;
  coverage: LaneCoverageFact[];
  committed: number;
  after: number;
  dailyCapacity: number | null;
}

/**
 * The review-and-commit screen (#275 required-change #3, wireframe 2 of
 * `assign-work-console.html`). The last screen before anything is written: a diff, not a confirm
 * dialog. It states what changes, what it costs, and what is still unassigned afterwards — and it is
 * where the mandatory reason lives (#272 R2 — nothing written until commit).
 */
export function ReviewCommitScreen({
  lanes,
  stillUnassignedAfter,
  noEligibleEngineerCount,
  committing,
  results,
  onBack,
  onCommit,
  onTicketResolved,
}: {
  lanes: ReviewLane[];
  stillUnassignedAfter: number;
  /** Of `stillUnassignedAfter`, how many have no eligible engineer at all — the wireframe's own callout. */
  noEligibleEngineerCount: number;
  committing: boolean;
  results: AssignBatchLaneResult[] | null;
  onBack: () => void;
  onCommit: (reasonCode: string) => void;
  /** A skipped ticket's hold was resolved outside the batch (#249's confirm flow) — refresh the pool. */
  onTicketResolved: () => void;
}) {
  const [reason, setReason] = useState('');
  const committingTotal = lanes.reduce((n, l) => n + l.ticketIds.length, 0);
  const overCapacityLanes = lanes.filter((l) => l.dailyCapacity !== null && isOverCapacity({ committed: l.after, dailyCapacity: l.dailyCapacity }));
  const reasonOk = reason.trim().length > 0;

  return (
    <div data-testid="review-commit-screen">
      <p className="mb-2 text-xs text-ink-muted">
        <span className="text-ink-strong">Assign work</span> › <b>Review &amp; commit</b>
      </p>

      <div className="mb-4 grid gap-3 rounded-card border border-line bg-surface-card p-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-ink-muted">Committing</div>
          <div className="text-xl font-semibold tabular-nums text-brand-700" data-testid="review-committing">
            {committingTotal}
          </div>
          <div className="text-[11px] text-ink-muted">devices → {lanes.length} engineers</div>
        </div>
        <div>
          <div className="text-xs text-ink-muted">Still unassigned after</div>
          <div className="text-xl font-semibold tabular-nums text-ink-strong" data-testid="review-still-unassigned">
            {stillUnassignedAfter}
          </div>
          {noEligibleEngineerCount > 0 && (
            <div className="text-[11px] text-ink-muted">including {noEligibleEngineerCount} with no eligible engineer</div>
          )}
        </div>
        <div>
          <div className="text-xs text-ink-muted">Over capacity</div>
          <div className="text-xl font-semibold tabular-nums text-critical" data-testid="review-over-capacity">
            {overCapacityLanes.length}
          </div>
          <div className="text-[11px] text-ink-muted">allowed — not blocked</div>
        </div>
        <div className="flex items-end">
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">one audit row per ticket</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-sunken text-left text-xs text-ink-muted">
              <th className="p-2">Engineer</th>
              <th className="p-2">Coverage used</th>
              <th className="p-2">Plants</th>
              <th className="p-2">Devices</th>
              <th className="p-2">Load</th>
              <th className="p-2">Flags</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => {
              const over = lane.dailyCapacity !== null && isOverCapacity({ committed: lane.after, dailyCapacity: lane.dailyCapacity });
              const times = lane.dailyCapacity && lane.dailyCapacity > 0 ? lane.after / lane.dailyCapacity : null;
              return (
                <tr key={lane.seId} data-testid={`review-lane-${lane.seId}`} className="border-b border-line last:border-0">
                  <td className="p-2 font-medium text-ink-strong">{lane.engineerName}</td>
                  <td className="p-2">
                    {lane.coverage.map((c) => (
                      <Badge key={c.plantId} tone={c.coverageType === null ? 'critical' : c.tierCrossing ? 'warning' : 'success'} className="mr-1">
                        {c.coverageType ?? 'NO COVERAGE'}
                        {c.tierCrossing ? ' · tier crossed' : ''}
                      </Badge>
                    ))}
                  </td>
                  <td className="p-2">{lane.plantNames.map(formatPlantDisplayName).join(', ')}</td>
                  <td className="p-2 tabular-nums">
                    {lane.ticketIds.length}
                    {lane.criticalCount > 0 && <span className="text-ink-muted"> ({lane.criticalCount} crit)</span>}
                  </td>
                  <td className={`p-2 tabular-nums ${over ? 'font-semibold text-warning' : ''}`}>
                    {lane.committed} → {lane.after}
                    {lane.dailyCapacity !== null && ` / ${lane.dailyCapacity}`}
                  </td>
                  <td className="p-2">
                    {over ? (
                      <Badge tone="warning">{times ? `${times.toFixed(0)}× capacity` : 'over capacity'}</Badge>
                    ) : (
                      <Badge tone="success">within capacity</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-card border border-line bg-surface-card p-3">
        <label htmlFor="assign-batch-reason" className="mb-1 block text-xs font-semibold text-ink-strong">
          Reason for this manual plan — required
        </label>
        <textarea
          id="assign-batch-reason"
          data-testid="review-reason"
          className="w-full rounded-md border border-line px-2 py-1.5 text-sm"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this plan being made?"
        />
      </div>

      {overCapacityLanes.length > 0 && (
        <p className="mt-3 text-sm text-ink-strong" data-testid="review-overcapacity-copy">
          {overCapacityLanes.map((l) => l.engineerName).join(', ')}{' '}
          {overCapacityLanes.length === 1 ? 'is' : 'are'} being taken to{' '}
          <b className="text-warning">
            {overCapacityLanes
              .map((l) => (l.dailyCapacity && l.dailyCapacity > 0 ? `${(l.after / l.dailyCapacity).toFixed(0)}× daily capacity` : 'over daily capacity'))
              .join(', ')}
          </b>
          . This is allowed and will be recorded — it is not blocked.
        </p>
      )}

      {results && (
        <div className="mt-3 space-y-2" data-testid="assign-batch-results">
          {results.map((r) => (
            <div key={r.seId} data-testid={`batch-result-${r.seId}`} className="text-xs">
              <p>
                <span className="font-medium text-ink-strong">
                  {lanes.find((l) => l.seId === r.seId)?.engineerName ?? r.seId}
                </span>{' '}
                {r.result === 'OK' ? (
                  <span className="text-success">
                    assigned {r.assigned}
                    {r.alreadyAssigned > 0 && `, ${r.alreadyAssigned} already assigned`}
                    {r.skipped.length > 0 && `, ${r.skipped.length} skipped`}
                  </span>
                ) : (
                  <span className="text-critical">{r.result === 'SE_NOT_FOUND' ? 'engineer not found' : 'lane failed — nothing written for this engineer'}</span>
                )}
              </p>
              {r.skipped.length > 0 && (
                <ul className="ml-4 mt-1 space-y-1">
                  {r.skipped.map((s) => (
                    <li key={s.ticketId} className="flex items-center gap-2 text-ink-muted">
                      <span>
                        {s.ticketId.slice(0, 8)} — {s.reason.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      {/* #249 — a held ticket is not a dead end: resolve it through the exact confirm
                          flow every other manual-assign surface uses, without touching the rest of
                          this lane, which is already written or already reported. */}
                      {s.reason === 'CONFLICT_DEFERRED' && (
                        <ResolveHeldTicket ticketId={s.ticketId} seId={r.seId} onResolved={onTicketResolved} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 rounded-card border border-line bg-surface-card p-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={committing}>
          Back to draft
        </Button>
        <span className="ml-auto" />
        <Button
          size="sm"
          disabled={!reasonOk || committing || lanes.length === 0}
          loading={committing}
          onClick={() => onCommit(reason.trim())}
        >
          Commit {committingTotal} assignment{committingTotal === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}
