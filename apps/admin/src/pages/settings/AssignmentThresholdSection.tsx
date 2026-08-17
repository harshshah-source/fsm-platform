import { useCallback, useEffect, useState } from 'react';
import {
  getAssignmentThreshold,
  lockAssignmentThreshold,
  revertAssignmentThreshold,
  setAssignmentThreshold,
  unlockAssignmentThreshold,
  type AssignmentThreshold,
  type ThresholdChange,
  type ThresholdWriteResult,
} from '../../api/assignmentThreshold';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';

const inputClass =
  'h-9 rounded-md border border-line bg-surface-card px-3 text-sm text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40';

const ROLE_SHORT: Record<string, string> = {
  OPERATIONS_HEAD: 'Operations Head',
  CENTRAL_SERVICE_MANAGER: 'CSM',
  ZONAL_MANAGER: 'Zonal Manager',
};

const CHANGE_LABEL: Record<ThresholdChange['changeType'], string> = {
  SET: 'Changed',
  REVERT: 'Reverted',
  LOCK: 'Locked',
  UNLOCK: 'Unlocked',
};

const CHANGE_TONE: Record<ThresholdChange['changeType'], 'neutral' | 'info' | 'warning'> = {
  SET: 'info',
  REVERT: 'warning',
  LOCK: 'warning',
  UNLOCK: 'neutral',
};

/** `48` → `48 h+`. The trailing `+` is not decoration: the value is a floor, and an operator reading
 *  a bare "48" reasonably reads it as a window rather than a minimum. */
const hoursLabel = (h: number): string => (h >= 24 && h % 24 === 0 ? `${h} h+  (${h / 24}d)` : `${h} h+`);

/**
 * The sentence under the dropdown. This is the part of the screen that earns its place: the number
 * alone does not tell an operator what they are about to do, and the two thresholds interact in a way
 * that is easy to get backwards. So the consequence is spelled out against the live Inactive
 * definition, in the direction the choice actually points.
 */
function effectSentence(hours: number, inactivityHours: number): string {
  if (hours === inactivityHours) {
    return `A device is dispatched to an SE at the same point it is counted Inactive (${inactivityHours} h). Tickets and the fleet KPIs agree exactly.`;
  }
  if (hours > inactivityHours) {
    return `A device is counted Inactive on the dashboards after ${inactivityHours} h but no SE is assigned until ${hours} h — a ${hours - inactivityHours} h grace window for devices that recover on their own. Fleet Uptime is unaffected.`;
  }
  return `Work is opened at ${hours} h, before a device is counted Inactive at ${inactivityHours} h. Expect more tickets, some for devices the dashboards still show as healthy. Fleet Uptime is unaffected.`;
}

/**
 * #238 — SE-assignment threshold: how long a device must be silent before the platform turns that
 * silence into work for a Service Engineer.
 *
 * Three things this deliberately shows that a plain number field would not:
 *
 *  1. **What the choice does**, phrased against the live Inactive definition. The two thresholds are
 *     independent and the relationship between them is the whole decision; a dropdown without it asks
 *     an operator to hold the interaction in their head.
 *  2. **Who currently holds the key.** The Operations Head and the CSM both write it, and the OH can
 *     lock it. A CSM who finds the control disabled must be able to read *why*, by whom, and with
 *     what stated reason — otherwise a deliberate governance act is indistinguishable from a bug.
 *  3. **What it used to be.** Every change carries its predecessor, so the history is a revert
 *     target rather than a log: the OH restores a specific past decision instead of retyping a number
 *     they hope was the old one.
 *
 * Authority comes from the server (`canEdit` / `canLock`), never from the session role — the UI must
 * not be a second, drifting copy of the rules the API enforces.
 */
export function AssignmentThresholdSection() {
  const [data, setData] = useState<AssignmentThreshold | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await getAssignmentThreshold();
      setData(view);
      setDraft(view.hours);
    } catch {
      setError('Failed to load the SE-assignment threshold.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation funnels through here so a refusal is rendered the same way whatever caused it. */
  const run = async (action: () => Promise<ThresholdWriteResult>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await action();
      if (outcome.result === 'REFUSED') {
        setError(outcome.reason);
        return;
      }
      setData(outcome.threshold);
      setDraft(outcome.threshold.hours);
      setReason('');
      setNotice(success);
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  if (data === null) {
    return (
      <section className="text-sm text-ink-muted">
        {error ? (
          <p role="alert" className="text-critical">
            {error}
          </p>
        ) : (
          'Loading…'
        )}
      </section>
    );
  }

  const locked = data.lock.locked;
  const dirty = draft !== null && draft !== data.hours;

  return (
    <section className="flex max-w-3xl flex-col gap-5">
      <p className="text-sm text-ink-muted">
        How long a device must stay silent before the platform opens a Troubleshoot Ticket and
        auto-assigns a Service Engineer. Changes take effect on the next dispatch run — no restart.
      </p>

      {/* Authority, stated up front. A disabled control with no explanation reads as a bug. */}
      <div
        data-testid="threshold-authority"
        className={cn(
          'rounded-card border px-3 py-2 text-sm',
          locked ? 'border-warning/30 bg-warning-bg text-warning' : 'border-line bg-surface-card text-ink',
        )}
      >
        {locked ? (
          <>
            <strong>Locked by {ROLE_SHORT[data.lock.lockedByRole ?? ''] ?? data.lock.lockedByRole ?? 'the Operations Head'}.</strong>{' '}
            {data.lock.lockReason ? <span>{data.lock.lockReason} </span> : null}
            Only the Operations Head can change it while it is locked.
          </>
        ) : (
          <>
            Editable by {data.writeRoles.map((r) => ROLE_SHORT[r] ?? r).join(' and ')}. The Operations
            Head can lock this setting at any time to take sole control.
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" data-testid="threshold-saved" className="text-sm text-success">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">
            Assign an SE after
          </span>
          <select
            aria-label="SE assignment threshold"
            data-testid="threshold-select"
            className={inputClass}
            disabled={!data.canEdit || busy}
            value={draft ?? data.hours}
            onChange={(e) => setDraft(Number(e.target.value))}
          >
            {data.options.map((h) => (
              <option key={h} value={h}>
                {hoursLabel(h)}
                {h === data.defaultHours ? ' — default' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">
            Reason (recorded in the history)
          </span>
          <input
            aria-label="Reason for the threshold change"
            className={inputClass}
            disabled={!data.canEdit || busy}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        <Button
          type="button"
          data-testid="threshold-save"
          disabled={!data.canEdit || !dirty}
          loading={busy}
          onClick={() => run(() => setAssignmentThreshold(draft!, reason), `Saved — SEs are now assigned after ${draft} h of silence.`)}
        >
          Save threshold
        </Button>
      </div>

      {/* The consequence of the *pending* choice, not the saved one — it has to be readable before
          the operator commits, which is the only moment it can still change their mind. */}
      <p data-testid="threshold-effect" className="rounded-card border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
        {effectSentence(draft ?? data.hours, data.inactivityThresholdHours)}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-subtle">In force</dt>
        <dd className="font-semibold text-ink-strong" data-testid="threshold-current">
          {hoursLabel(data.hours)}
        </dd>
        <dt className="text-ink-subtle">Inactive definition</dt>
        <dd className="text-ink-strong">
          {data.inactivityThresholdHours} h{' '}
          <span className="text-ink-muted">— separate setting; drives Fleet Uptime and the SLA buckets</span>
        </dd>
        <dt className="text-ink-subtle">Last changed</dt>
        <dd className="text-ink-strong">{data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '—'}</dd>
      </dl>

      {data.canLock && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">
            Operations Head control
          </span>
          {locked ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="threshold-unlock"
              loading={busy}
              onClick={() => run(() => unlockAssignmentThreshold(reason), 'Unlocked — the CSM can change the threshold again.')}
            >
              Unlock
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="threshold-lock"
              loading={busy}
              onClick={() => run(() => lockAssignmentThreshold(reason), 'Locked — only the Operations Head can change the threshold now.')}
            >
              Lock to Operations Head
            </Button>
          )}
          <span className="text-xs text-ink-muted">Uses the reason field above.</span>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-caps">Change history</h3>
        {data.history.length === 0 ? (
          <p className="text-sm text-ink-muted">No changes recorded yet.</p>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
            <table aria-label="Assignment threshold history" className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-chrome-700 bg-chrome-900 text-left">
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">When</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">Change</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">By</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">Reason</th>
                  {data.canLock && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-ink">{new Date(h.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <Badge tone={CHANGE_TONE[h.changeType]}>{CHANGE_LABEL[h.changeType]}</Badge>{' '}
                      {h.newHours !== null && (
                        <span className="text-ink">
                          {h.previousHours !== null ? `${h.previousHours} h → ` : ''}
                          <strong>{h.newHours} h</strong>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink">{ROLE_SHORT[h.actorRole] ?? h.actorRole}</td>
                    <td className="px-3 py-2 text-ink-muted">{h.reason ?? '—'}</td>
                    {data.canLock && (
                      <td className="px-3 py-2 text-right">
                        {/* Only value-bearing rows can be reverted; a lock moved authority, not value. */}
                        {h.newHours !== null && h.newHours !== data.hours && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`threshold-revert-${h.id}`}
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => revertAssignmentThreshold(h.id, reason),
                                `Reverted — SEs are now assigned after ${h.newHours} h of silence.`,
                              )
                            }
                          >
                            Revert to {h.newHours} h
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
