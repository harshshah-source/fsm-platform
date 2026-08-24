import { useEffect, useState } from 'react';
import { TIER_LABEL, type CandidateRow } from '../../api/candidates';
import { apiAvailableSes, apiManualAssign, type IntradayInsertionRow } from '../../api/intradayInsertions';
import { DeferralConflictError, type DeferralConflict } from '../../api/schedules';
import { DeferralConfirm } from '../../components/domain';
import { Modal } from '../../components/overlay';
import { Badge, Button, LoadBadge } from '../../components/ui';

/**
 * The intra-day manual-assign modal (Issue 30, #277) — the admin client `available-ses` +
 * `manual-assign` never had. Lists #274's candidate row for the escalated insertion's plant
 * (availability-filtered, same set as before #277 — see the backend's own set-equality pin) and
 * assigns on a click. `DeferralConfirm` (#249) is wired the same way `CriticalQueue`'s one-click
 * assign already carries it: a return-date hold is answerable inline, not a dead end.
 */
export function IntradayManualAssignModal({
  insertion,
  onClose,
  onAssigned,
}: {
  insertion: IntradayInsertionRow;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<DeferralConflict | null>(null);
  const [pendingSeId, setPendingSeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiAvailableSes(insertion.insertionId)
      .then((rows) => {
        if (!cancelled) setCandidates(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Failed to load available engineers.');
      });
    return () => {
      cancelled = true;
    };
  }, [insertion.insertionId]);

  const assign = async (seId: string, deferral: { confirm?: boolean; reasonCode?: string } = {}) => {
    setBusy(true);
    try {
      await apiManualAssign(insertion.insertionId, seId, deferral);
      setConflict(null);
      setPendingSeId(null);
      onAssigned();
    } catch (e) {
      if (e instanceof DeferralConflictError) {
        setPendingSeId(seId);
        setConflict(e.conflict);
      } else {
        setLoadError('Assignment failed — please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Assign engineer" className="max-w-lg">
      <p className="mb-3 text-sm text-ink-muted">
        Ticket <span className="font-mono">{insertion.ticketId.slice(0, 8)}</span> could not be auto-assigned. Pick an
        engineer to resolve the escalation.
      </p>

      {conflict && (
        <DeferralConfirm
          conflict={conflict}
          busy={busy}
          onConfirm={(reasonCode) => {
            if (pendingSeId) void assign(pendingSeId, { confirm: true, reasonCode });
          }}
          onCancel={() => {
            setConflict(null);
            setPendingSeId(null);
          }}
        />
      )}

      {loadError && (
        <p role="alert" className="mb-3 text-sm text-critical">
          {loadError}
        </p>
      )}

      {candidates === null && !loadError && <p className="text-sm text-ink-muted">Loading available engineers…</p>}

      {candidates !== null && candidates.length === 0 && (
        <p className="text-sm text-ink-muted">No available engineer covers this plant right now.</p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <ul className="space-y-1.5" data-testid="manual-assign-candidates">
          {candidates.map((c) => (
            <li
              key={c.seId}
              data-testid={`manual-assign-candidate-${c.seId}`}
              className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink-strong">{c.name ?? c.seId}</span>
              <Badge tone="neutral">{TIER_LABEL[c.coverageType]}</Badge>
              <LoadBadge seId={c.seId} committed={c.committed} dailyCapacity={c.dailyCapacity ?? undefined} />
              <Button size="sm" disabled={busy} onClick={() => void assign(c.seId)}>
                Assign
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
