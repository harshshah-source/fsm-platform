import { useId, useState } from 'react';
import type { DeferralConflict } from '../../api/schedules';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/** `2026-06-26T00:00:00.000Z` → `2026-06-26`. Return dates are IST calendar days, not instants —
 *  showing a time here would imply a precision the deferral does not have (#246, Decision 14). */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * #249 AC5 — the confirm a manager must pass to assign work that is held to a future vehicle-return
 * date.
 *
 * It is the ON_SITE conflict banner extended rather than a new pattern: same inline alert, same
 * Confirm/Cancel pair, one added field. The field is what is genuinely new — the ON_SITE flow reuses
 * the override command's existing `reasonCode`, and an assign has none to reuse, so without this the
 * confirm would be a bare "yes" and the audit row would say nothing about why.
 *
 * Both dates are shown when a report exists, because #245 separated them: `proposedFrom` is what the
 * SE standing at the plant reported and `expectedFrom` is what stands now, and a manager overruling a
 * hold should see whether they are overruling the field or their own colleague's decision. A ZM
 * deferral carries no report, and then the deferred-until date stands alone.
 */
export function DeferralConfirm({
  conflict,
  onConfirm,
  onCancel,
  busy = false,
}: {
  conflict: DeferralConflict;
  onConfirm: (reasonCode: string) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const stated = reason.trim() !== '';

  return (
    <div
      role="alert"
      data-testid="deferral-conflict-banner"
      className="mb-4 rounded-card border border-warning/40 bg-warning-bg p-3 text-sm text-warning"
    >
      <p className="font-semibold">Ticket is held to a vehicle-return date</p>
      <p className="mt-1">{conflict.message}</p>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div>
          <dt className="inline font-semibold">Held until: </dt>
          <dd className="inline" data-testid="deferral-until">
            {day(conflict.deferredUntil)}
          </dd>
        </div>
        {conflict.vuReport && (
          <>
            <div>
              <dt className="inline font-semibold">SE reported: </dt>
              <dd className="inline" data-testid="deferral-proposed-from">
                {day(conflict.vuReport.proposedFrom)}
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold">Authoritative return: </dt>
              <dd className="inline" data-testid="deferral-expected-from">
                {day(conflict.vuReport.expectedFrom)}
              </dd>
            </div>
          </>
        )}
      </dl>
      <div className="mt-2 flex flex-col gap-1.5">
        <label htmlFor={reasonId} className="text-xs font-semibold">
          Reason for overriding the hold
        </label>
        <Input
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this being assigned before the vehicle is back?"
          className="max-w-lg"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!stated || busy}
          loading={busy}
          onClick={() => onConfirm(reason.trim())}
        >
          Confirm override
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
