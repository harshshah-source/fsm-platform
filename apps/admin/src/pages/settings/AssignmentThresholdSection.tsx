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
import { Badge, Button, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  cellClass,
  FactList,
  Field,
  Notice,
  Panel,
  PanelBand,
  rowClass,
  SettingsSection,
  SubHeading,
  TablePanel,
} from './primitives';

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
      <section aria-busy={!error}>
        {error ? (
          <Notice tone="critical">{error}</Notice>
        ) : (
          <div className="flex flex-col gap-4">
            <span className="sr-only">Loading the SE-assignment threshold…</span>
            <span aria-hidden className="h-5 w-56 animate-pulse rounded-full bg-line" />
            <span aria-hidden className="h-4 w-full max-w-[46rem] animate-pulse rounded-full bg-line" />
            <span aria-hidden className="mt-2 h-44 w-full animate-pulse rounded-card bg-line/60" />
          </div>
        )}
      </section>
    );
  }

  const locked = data.lock.locked;
  const dirty = draft !== null && draft !== data.hours;

  return (
    <SettingsSection
      title="SE assignment threshold"
      description="How long a device must stay silent before the platform opens a Troubleshoot Ticket and auto-assigns a Service Engineer. Changes take effect on the next dispatch run — no restart."
      meta={
        locked ? (
          <Badge tone="warning" dot>
            Locked
          </Badge>
        ) : (
          <Badge tone="neutral">Co-owned</Badge>
        )
      }
    >
      {/* Authority, stated up front. A disabled control with no explanation reads as a bug. */}
      <Notice tone={locked ? 'warning' : 'neutral'} data-testid="threshold-authority">
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
      </Notice>

      {error && <Notice tone="critical">{error}</Notice>}
      {notice && (
        <Notice tone="success" role="status" data-testid="threshold-saved">
          {notice}
        </Notice>
      )}

      {/* The decision itself, as one object: the choice on top, what the *pending* choice would do
          directly beneath it, and what is actually in force along the bottom. They belong together —
          the consequence is only useful while the operator can still change their mind, and the
          current value is what they are changing *from*. */}
      <Panel>
        <PanelBand>
          <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
            <Field label="Assign an SE after" className="sm:w-52">
              <Select
                aria-label="SE assignment threshold"
                data-testid="threshold-select"
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
              </Select>
            </Field>

            <Field label="Reason (recorded in the history)" className="min-w-56 flex-1 sm:w-auto">
              <Input
                aria-label="Reason for the threshold change"
                disabled={!data.canEdit || busy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>

            <Button
              className="w-full sm:w-auto"
              type="button"
              data-testid="threshold-save"
              disabled={!data.canEdit || !dirty}
              loading={busy}
              onClick={() => run(() => setAssignmentThreshold(draft!, reason), `Saved — SEs are now assigned after ${draft} h of silence.`)}
            >
              Save threshold
            </Button>
          </div>
        </PanelBand>

        <p
          data-testid="threshold-effect"
          className={cn(
            'px-4 py-3.5 text-sm leading-6 sm:px-5',
            dirty ? 'bg-info-bg text-info' : 'text-ink-muted',
          )}
        >
          {effectSentence(draft ?? data.hours, data.inactivityThresholdHours)}
        </p>

        <PanelBand position="bottom">
          <div className="px-4 py-4 sm:px-5">
            <FactList
              items={[
                {
                  term: 'In force',
                  value: (
                    <span className="font-semibold" data-testid="threshold-current">
                      {hoursLabel(data.hours)}
                    </span>
                  ),
                },
                {
                  term: 'Inactive definition',
                  value: (
                    <>
                      {data.inactivityThresholdHours} h{' '}
                      <span className="text-ink-muted">
                        — separate setting; drives Fleet Uptime and the SLA buckets
                      </span>
                    </>
                  ),
                },
                {
                  term: 'Last changed',
                  value: data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '—',
                },
              ]}
            />
          </div>
        </PanelBand>
      </Panel>

      {data.canLock && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-6">
          <div className="mr-auto min-w-0 max-w-[62ch]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
              Operations Head control
            </p>
            <p className="mt-1 text-sm leading-6 text-ink-muted">
              {locked
                ? 'Unlocking returns write access to the CSM. Uses the reason field above.'
                : 'Locking takes sole control of this setting. Uses the reason field above.'}
            </p>
          </div>
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
        </div>
      )}

      <div className="border-t border-line pt-6">
        <SubHeading hint="Each entry carries the value it replaced, so a past decision can be restored rather than retyped.">
          Change history
        </SubHeading>
        <TablePanel
          ariaLabel="Assignment threshold history"
          headers={[
            { label: 'When' },
            { label: 'Change' },
            { label: 'By' },
            { label: 'Reason', hideBelow: 'md' },
            ...(data.canLock ? [{ label: <span className="sr-only">Revert</span>, align: 'right' as const }] : []),
          ]}
          rowCount={data.history.length}
          emptyMessage="No changes recorded yet."
        >
          {data.history.map((h) => (
            <tr key={h.id} className={rowClass}>
              <td className={cn(cellClass, 'whitespace-nowrap text-ink-muted')}>
                {new Date(h.createdAt).toLocaleString()}
              </td>
              <td className={cellClass}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={CHANGE_TONE[h.changeType]}>{CHANGE_LABEL[h.changeType]}</Badge>
                  {h.newHours !== null && (
                    <span className="text-ink tabular-nums">
                      {h.previousHours !== null ? `${h.previousHours} h → ` : ''}
                      <strong className="text-ink-strong">{h.newHours} h</strong>
                    </span>
                  )}
                </span>
              </td>
              <td className={cellClass}>{ROLE_SHORT[h.actorRole] ?? h.actorRole}</td>
              <td className={cn(cellClass, 'hidden text-ink-muted md:table-cell')}>{h.reason ?? '—'}</td>
              {data.canLock && (
                <td className={cn(cellClass, 'whitespace-nowrap text-right')}>
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
        </TablePanel>
      </div>
    </SettingsSection>
  );
}
