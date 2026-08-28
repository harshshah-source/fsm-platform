import { useEffect, useState } from 'react';
import { runDispatch, type DispatchRunSummary } from '../../../api/bulkUnassign';
import { getDispatchInFlight, type DispatchInFlight } from '../../../api/dispatchSchedule';
import { Badge } from '../../../components/ui';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'refused';

/**
 * **Run Now — CONTROL, on the Console** (slice §10.2, fixing C3).
 *
 * The cockpit shipped with a "Run dispatch" button that was a `<Link to="/bulk-unassign">`, and
 * `/bulk-unassign` is `<RoleRoute roles={['OPERATIONS_HEAD']}>` whose miss path is a redirect to `/`.
 * For a Zonal Manager and a Central Service Manager — two of this screen's three primary users — the
 * button silently bounced them to the dashboard. This control replaces it with the real trigger,
 * `POST /schedules/dispatch-run`, in the frame where the operator already is.
 *
 * **Rendered for the roles the endpoint already serves.** Today that is `CENTRAL_SERVICE_MANAGER` and
 * `OPERATIONS_HEAD`; a ZM cannot call it. Widening it to ZM is deliberately *not* done here — it needs
 * the zone clamp shipped in the same change (see slice §9 B3: the endpoint reads `zoneId` from the
 * request body and never checks it against the caller, which is safe only while every caller is a
 * global-scope role) and an explicit decision record for the RBAC reversal. So the control is
 * **hidden** for a ZM rather than disabled — the same hide-don't-disable rule the rest of the Console
 * follows.
 *
 * Three behaviours this control must have, each of which is a real property of the engine rather than
 * UI decoration:
 *
 * 1. **The in-flight guard.** A run already in flight comes back as a populated 409
 *    (`DISPATCH_ALREADY_RUNNING`) carrying which zone and since when. The pre-check disables the
 *    button *before* it is pressed; the 409 is still handled, because the check is a courtesy and the
 *    server is the authority.
 * 2. **A manual run notifies engineers.** Day-plan notifications ride the same commit path as the
 *    05:00 run, so a mid-day Run Now can push work onto a phone mid-shift. That is correct behaviour
 *    and the operator has to be told before they press it, not after.
 * 3. **The zero-result state is designed, not incidental.** The engine only looks at work that is
 *    `OPEN` **and** `UNASSIGNED`, so with inputs unchanged a re-run legitimately places nothing.
 *    Without a "0 new assignments — and here is why" state, this control teaches managers that the
 *    scheduler is broken every time they press it twice.
 */
export function RunNowControl({
  zoneId,
  zoneName,
  onCompleted,
}: {
  zoneId: string;
  zoneName: string;
  /** The Console's single lifted fetch. A run that placed work must be visible without a reload. */
  onCompleted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState('');
  const [inFlight, setInFlight] = useState<DispatchInFlight[]>([]);
  const [summary, setSummary] = useState<DispatchRunSummary | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The pre-check is global today — `inFlightZones()` takes no scope argument — so it is read as
  // "is anything running", not "is this zone running". Narrowing it is part of the B3 clamp.
  useEffect(() => {
    let live = true;
    void getDispatchInFlight()
      .then((f) => live && setInFlight(f))
      .catch(() => live && setInFlight([]));
    return () => {
      live = false;
    };
  }, [phase]);

  const busy = inFlight.find((f) => f.zoneId === zoneId) ?? null;

  const execute = async () => {
    setPhase('running');
    setRefusal(null);
    try {
      const res = await runDispatch(Number(zoneId), reason.trim() || undefined);
      if (res.result === 'ALREADY_RUNNING') {
        setRefusal(res.message);
        setPhase('refused');
        return;
      }
      setSummary(res.summary);
      setPhase('done');
      onCompleted();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : 'The run could not be started.');
      setPhase('refused');
    }
  };

  if (phase === 'idle') {
    return (
      <Button
        data-testid="console-run-now"
        onClick={() => setPhase('confirming')}
        disabled={busy !== null}
        title={busy ? `A run for this zone started ${new Date(busy.startedAt).toLocaleTimeString()}` : undefined}
      >
        {busy ? 'Dispatch running…' : 'Run now'}
      </Button>
    );
  }

  return (
    <div
      data-testid="console-run-now-dialog"
      className="w-full rounded-lg border-2 border-brand-600 bg-surface p-3 sm:w-96"
    >
      {phase === 'confirming' && (
        <>
          <h3 className="text-sm font-semibold text-ink">Run dispatch for {zoneName}?</h3>
          {/* Not a footnote. This is the one consequence an operator cannot undo. */}
          <p
            data-testid="run-now-notifies-warning"
            className="mt-2 rounded border border-warning bg-warning-bg/40 px-2 py-1.5 text-[11px] text-ink"
          >
            <strong>Engineers are notified.</strong> A manual run commits day plans through the same
            path as the 05:00 run, so any work it places is pushed to engineers' phones immediately —
            mid-shift, if it is mid-shift.
          </p>
          <p className="mt-2 text-[11px] text-ink-muted">
            The run considers work that is still open and unassigned. Anything already on a plan is
            left alone.
          </p>
          <label className="mt-2 block text-[11px] text-ink-muted">
            Reason (optional, recorded on the run)
            <Input
              className="mt-1 h-8 text-xs"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. new critical tickets since this morning"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <Button data-testid="run-now-confirm" onClick={() => void execute()}>
              Run dispatch
            </Button>
            <Button variant="secondary" onClick={() => setPhase('idle')}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {phase === 'running' && <p className="text-sm text-ink">Running dispatch for {zoneName}…</p>}

      {phase === 'refused' && (
        <>
          <h3 className="text-sm font-semibold text-warning">The run did not start</h3>
          <p data-testid="run-now-refused" className="mt-1 text-[11px] text-ink">
            {refusal}
          </p>
          <Button className="mt-3" variant="secondary" onClick={() => setPhase('idle')}>
            Close
          </Button>
        </>
      )}

      {phase === 'done' && summary && (
        <>
          {/*
            The zero-result state, spelled out. `tickets === 0` is the common case on a second press
            and it is not a failure: the engine looks only at OPEN + UNASSIGNED work, so with inputs
            unchanged there is nothing left for it to place. Rendering this as a bare "0" — or worse,
            as a success toast — is how a manager learns to distrust the scheduler.
          */}
          {summary.tickets === 0 ? (
            <div data-testid="run-now-zero-result">
              <h3 className="text-sm font-semibold text-ink">No new assignments</h3>
              <p className="mt-1 text-[11px] text-ink-muted">
                The run completed and placed nothing — that is the expected result when nothing has
                changed. Dispatch only considers tickets that are still <strong>open</strong> and{' '}
                <strong>unassigned</strong>; work already on a plan is never re-planned, and work that
                is held, withheld by policy or without an eligible engineer stays where the rails show
                it.
              </p>
            </div>
          ) : (
            <div data-testid="run-now-result">
              <h3 className="text-sm font-semibold text-ink">Dispatch complete</h3>
              <p className="mt-1 text-[11px] text-ink">
                <span className="tabular-nums font-semibold">{summary.tickets}</span>{' '}
                {summary.tickets === 1 ? 'ticket' : 'tickets'} placed across{' '}
                <span className="tabular-nums font-semibold">{summary.schedules}</span>{' '}
                {summary.schedules === 1 ? 'day plan' : 'day plans'}.
              </p>
            </div>
          )}
          {summary.errors.length > 0 && (
            <ul data-testid="run-now-errors" className="mt-2 flex flex-col gap-1">
              {summary.errors.map((e) => (
                <li key={e.zoneId} className="text-[11px] text-critical">
                  <Badge tone="critical">zone {e.zoneId}</Badge> {e.message}
                </li>
              ))}
            </ul>
          )}
          <Button
            className="mt-3"
            variant="secondary"
            onClick={() => {
              setPhase('idle');
              setSummary(null);
              setReason('');
            }}
          >
            Close
          </Button>
        </>
      )}
    </div>
  );
}
