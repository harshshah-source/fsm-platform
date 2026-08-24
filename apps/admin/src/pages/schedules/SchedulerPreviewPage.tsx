import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiOperatingMode } from '../../api/operatingMode';
import { apiListPlannerPlants } from '../../api/planner';
import { apiZoneEngineers } from '../../api/schedules';
import {
  getSchedulerPreview,
  placeHold,
  releaseHold,
  type HoldInForce,
  type PreviewDecision,
  type SchedulerPreviewResult,
  type ZoneProjection,
} from '../../api/schedulerPreview';
import { EmptyState, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { SLABadge, TierBadge } from '../../components/domain/badges';
import { Badge } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import { IconCalendar } from '../../components/ui/icons';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { operatingModeLabel } from '../../utils/operatingModeCopy';
import { DispatchTimelineNote } from '../../components/domain/DispatchTimelineNote';

/**
 * Scheduler Preview (#251) — what the next dispatch run *would* do, and the one pre-run lever an
 * admin has over it.
 *
 * **The framing this page must not get wrong.** Admin approval is never required (Decision 1/18):
 * doing nothing here means the 05:00 run proceeds exactly as if nobody looked. So there is no
 * Approve button, no countdown, and no "submit" — the only action is a hold, which is a date on a
 * ticket that the run's existing deferral predicate already respects. The copy says this outright
 * rather than leaving an operator to infer it from the absence of a button, which is the same posture
 * the built Batch Schedule page takes about post-hoc overrides.
 *
 * **Layout** follows `docs/ui/desktop/v2-reference/12-batch-schedule-review.png` — the reference for
 * this exact data shape (SE rail → plant stops → ticket rows, KPI strip above). That page is the
 * *post*-dispatch twin of this one, so matching it is what makes the two read as one workflow rather
 * than two designs. No v2 image exists for the preview itself; nothing novel is invented here.
 *
 * **The caveat is not decoration.** Severity buckets and inactivity are materialised as of the last
 * recompute, so a D+1 projection ranks tomorrow's plan on today's severities. `bucketsAsOf` is
 * rendered verbatim because a preview that hid it would look authoritative about an ordering it
 * cannot know.
 *
 * **#281 AC10 (audit §2.5 D2) — names, not keys.** This page shipped rendering `seId.slice(0, 8)`,
 * `Plant {plantId}` and `Zone {zoneId}`, and used `formatPlantDisplayName` zero times: three internal
 * keys on the one screen whose entire purpose is letting a human read a plan. The projection payload
 * carries ids only, so the names come from three reads that already exist and are already gated to
 * these same manager roles — `/schedules/engineers`, `/planner/plants` and `/dashboard/operating-mode`
 * (no new endpoint, #281 AC14). All three are **best-effort**: the projection is the primary content,
 * so a failed lookup falls back to the id (`name ?? id`, the #277 `PlannerPage` pattern) rather than
 * failing the page.
 *
 * **#281 AC8 (#280 R8) — the cross-view links are per-record.** `?date=` / `?se=` make a projection
 * addressable so a sibling view can link INTO one, and the selected SE offers their committed day
 * plan. Deliberately not a shared switcher and not a tab strip: this page is a projection and the one
 * thing it must never do is read as a commitment (#280 R2).
 */

/** Tomorrow in IST, `YYYY-MM-DD` — the default a scheduler actually wants to look at. */
function defaultPreviewDate(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  ist.setUTCDate(ist.getUTCDate() + 1);
  return ist.toISOString().slice(0, 10);
}

function formatWatermark(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

export function SchedulerPreviewPage() {
  /**
   * The previewed date and the selected SE live in the URL so a projection is an ADDRESS — that is
   * what makes a per-record link from a sibling view possible at all (#280 R8). Absent params keep
   * the old behaviour exactly: tomorrow, and the first projected SE.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const urlDate = searchParams.get('date');
  const urlSe = searchParams.get('se');
  const [date, setDate] = useState(urlDate ?? defaultPreviewDate());
  const [preview, setPreview] = useState<SchedulerPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSe, setSelectedSe] = useState<string | null>(urlSe);
  /**
   * #281 AC10 — id → name lookups. Held as plain arrays and resolved through the helpers below so a
   * backend that answers with something other than a list (version skew) degrades to "no names"
   * rather than throwing inside a render.
   */
  const [engineerNames, setEngineerNames] = useState<Map<string, string>>(new Map());
  const [plantNames, setPlantNames] = useState<Map<string, string>>(new Map());
  const [zoneNames, setZoneNames] = useState<Map<string, string>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  /** A hold refused because the ticket carries an open vehicle-return report — awaiting confirm. */
  const [vuConflict, setVuConflict] = useState<{ ticketId: string; expectedFrom: string } | null>(null);

  const load = useCallback(
    (forDate: string) => {
      setLoading(true);
      setError(null);
      getSchedulerPreview(forDate)
        .then((r) => {
          setPreview(r);
          setSelectedSe((prev) => prev ?? r.zones.flatMap((z) => z.plan)[0]?.seId ?? null);
        })
        .catch(() => setError('Failed to load the projected plan.'))
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(() => load(date), [load, date]);

  // Keep the URL in step with the two pieces of state a sibling view can address. `replace` — moving
  // around inside one projection is not a navigation the Back button should have to unwind step by
  // step (the same convention the Settings console uses for `?tab=`).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set('date', date);
    if (selectedSe) next.set('se', selectedSe);
    else next.delete('se');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [date, selectedSe, searchParams, setSearchParams]);

  /**
   * The three name lookups. Fired once, not per date: none of them is date-scoped, and each is
   * independently best-effort — one failing must not cost the page the other two.
   */
  useEffect(() => {
    let alive = true;
    const asMap = <T,>(rows: T[], key: (r: T) => string, value: (r: T) => string | null) => {
      const map = new Map<string, string>();
      // Runtime guard, not a type guard: a backend answering with something other than a list
      // (version skew, an error body served as 200) must cost the names, never the page.
      if (!Array.isArray(rows)) return map;
      for (const row of rows) {
        const v = value(row);
        if (v) map.set(key(row), v);
      }
      return map;
    };

    apiZoneEngineers()
      .then((rows) => alive && setEngineerNames(asMap(rows, (e) => e.engineerId, (e) => e.name ?? null)))
      .catch(() => undefined);
    apiListPlannerPlants()
      .then((rows) => alive && setPlantNames(asMap(rows, (p) => p.plantId, (p) => p.name ?? null)))
      .catch(() => undefined);
    apiOperatingMode()
      .then((rows) => alive && setZoneNames(asMap(rows, (z) => z.zoneId, (z) => z.zoneName ?? null)))
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  // `name ?? id` — the #277 PlannerPage rule. A null name is a normal reading (an SE with no user
  // record, an unmapped plant code), never a crash and never a blank cell.
  const seLabel = useCallback(
    (seId: string) => engineerNames.get(seId) ?? seId.slice(0, 8),
    [engineerNames],
  );
  const plantLabel = useCallback(
    (plantId: string) => {
      const name = plantNames.get(plantId);
      return name ? formatPlantDisplayName(name) || name : `Plant ${plantId}`;
    },
    [plantNames],
  );
  const zoneLabel = useCallback(
    (zoneId: string) => zoneNames.get(zoneId) ?? `Zone ${zoneId}`,
    [zoneNames],
  );

  const zones = preview?.zones ?? [];
  const decisionsByTicket = useMemo(() => {
    const map = new Map<string, PreviewDecision>();
    for (const z of zones) for (const d of z.decisions) map.set(d.ticketId, d);
    return map;
  }, [zones]);

  /** Every projected SE across zones, with the zone they belong to — the left rail's rows. */
  const seRows = useMemo(
    () =>
      zones.flatMap((z) =>
        z.plan.map((entry) => ({
          zoneId: z.zoneId,
          seId: entry.seId,
          stops: entry.plants.length,
          tickets: entry.plants.reduce((n, p) => n + p.ticketIds.length, 0),
        })),
      ),
    [zones],
  );

  const metrics: Metric[] = useMemo(() => {
    const recommended = zones.reduce((n, z) => n + z.recommended, 0);
    const unassignable = zones.reduce((n, z) => n + z.unassignable, 0);
    const withheld = zones.reduce((n, z) => n + z.withheldBelowThreshold, 0);
    return [
      { label: 'SEs Projected', value: seRows.length, hint: 'would receive a day plan', tone: 'info' },
      { label: 'Tickets Placed', value: recommended, hint: 'across all plant stops', tone: 'brand' },
      {
        label: 'Unassignable',
        value: unassignable,
        hint: 'no eligible SE — needs action',
        tone: unassignable > 0 ? 'warning' : 'success',
      },
      {
        label: 'Withheld',
        value: withheld,
        hint: 'below assignment threshold — policy, not a fault',
        tone: 'neutral',
      },
      { label: 'Holds In Force', value: preview?.holds.length ?? 0, hint: 'excluded by an admin hold', tone: 'neutral' },
    ];
  }, [zones, seRows.length, preview?.holds.length]);

  const selected = useMemo(() => {
    for (const z of zones) {
      const entry = z.plan.find((p) => p.seId === selectedSe);
      if (entry) return { zone: z, entry };
    }
    return null;
  }, [zones, selectedSe]);

  const doHold = async (ticketId: string, confirm = false) => {
    setNotice(null);
    // Held "until" the day AFTER the previewed one: `notDeferredOn` is inclusive, so a ticket held
    // until D is still dispatchable on D. Naming D+1 is what actually keeps it out of D's run.
    const heldUntil = new Date(`${date}T00:00:00Z`);
    heldUntil.setUTCDate(heldUntil.getUTCDate() + 1);
    const res = await placeHold({
      ticketId,
      heldUntil: heldUntil.toISOString().slice(0, 10),
      reasonCode: 'ADMIN_PRE_RUN_HOLD',
      confirm,
    }).catch(() => null);

    if (!res) {
      setError('Could not place the hold.');
      return;
    }
    if (res.result === 'CONFLICT_VEHICLE_UNAVAILABLE') {
      setVuConflict({ ticketId, expectedFrom: res.expectedFrom });
      return;
    }
    if (res.result === 'NOT_HOLDABLE') {
      setNotice('That ticket is already on a day plan — adjust it from the batch override instead.');
      return;
    }
    if (res.result === 'NOT_FOUND') {
      setNotice('Ticket not found in your zone.');
      return;
    }
    setVuConflict(null);
    load(date);
  };

  const doRelease = async (ticketId: string) => {
    setNotice(null);
    await releaseHold(ticketId).catch(() => null);
    load(date);
  };

  return (
    <div>
      <PageHeader
        title="Scheduler Preview"
        subtitle="The plan the next dispatch run would produce for the selected date. Reviewing is optional — with no action here the run proceeds exactly as it would have. The only pre-run change available is holding a ticket back."
      />

      <DispatchTimelineNote position="future" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-muted" htmlFor="preview-date">
          Plan date
        </label>
        <input
          id="preview-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          data-testid="preview-date"
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
        />
        <Button onClick={() => load(date)} variant="secondary">
          Refresh
        </Button>
      </div>

      {/*
        AC-6, rendered verbatim. Buckets are materialised at recompute, so a future-dated projection
        ranks on today's severities — stated plainly rather than implied, and never omitted when the
        watermark is unknown.
      */}
      <div
        data-testid="buckets-as-of"
        className="mb-4 rounded-md border border-line bg-info-bg px-3 py-2 text-sm text-ink"
      >
        Severity buckets as of {formatWatermark(preview?.bucketsAsOf ?? null)} — the run re-evaluates at
        dispatch, so a future-dated plan is ranked on today&rsquo;s severities.
      </div>

      {notice && (
        <div data-testid="preview-notice" className="mb-4 rounded-md border border-line bg-warning-bg px-3 py-2 text-sm text-ink">
          {notice}
        </div>
      )}

      {vuConflict && (
        <div
          data-testid="vu-conflict"
          className="mb-4 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-ink"
        >
          This ticket already has a vehicle-return date of{' '}
          <strong>{new Date(vuConflict.expectedFrom).toISOString().slice(0, 10)}</strong>. A scheduler hold
          would replace it. Hold anyway?
          <span className="ml-3 inline-flex gap-2">
            <Button onClick={() => doHold(vuConflict.ticketId, true)}>Hold anyway</Button>
            <Button variant="secondary" onClick={() => setVuConflict(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      <MetricStrip metrics={metrics} />

      {error && <div className="mb-4 text-sm text-critical">{error}</div>}

      {!loading && seRows.length === 0 && (
        <EmptyState
          icon={<IconCalendar />}
          message="No work would be dispatched on this date. Nothing is wrong — there may be no eligible tickets, or every one is held or below the assignment threshold."
        />
      )}

      {seRows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {/* Left rail — one card per projected SE, mirroring reference 12's batch list. */}
          <div className="rounded-lg border border-line bg-surface" data-testid="preview-se-list">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs uppercase tracking-wide text-ink-muted">
              <span>Service Engineers</span>
              <span>{seRows.length} plans</span>
            </div>
            <ul>
              {seRows.map((row) => (
                <li key={`${row.zoneId}-${row.seId}`}>
                  <button
                    type="button"
                    data-testid={`preview-se-${row.seId}`}
                    onClick={() => setSelectedSe(row.seId)}
                    className={`w-full border-b border-line px-3 py-2 text-left hover:bg-surface-alt ${
                      selectedSe === row.seId ? 'bg-surface-alt' : ''
                    }`}
                  >
                    <div className="text-[13px] font-medium text-ink">{seLabel(row.seId)}</div>
                    <div className="mt-1 text-xs text-ink-muted">
                      {row.stops} plant{row.stops === 1 ? '' : 's'} · {row.tickets} ticket
                      {row.tickets === 1 ? '' : 's'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Right panel — the selected SE's projected stops, plant by plant. */}
          <div className="rounded-lg border border-line bg-surface p-4" data-testid="preview-detail">
            {selected ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{seLabel(selected.entry.seId)}</span>
                  <Badge tone="info">Projected</Badge>
                  <span className="text-xs text-ink-muted">{zoneLabel(selected.zone.zoneId)}</span>
                  {/* Issue 136's vocabulary rule — the mode enum is translated in one module and
                      never rendered raw. An unknown value degrades to nothing rather than leaking. */}
                  {operatingModeLabel(selected.zone.mode) && (
                    <span className="text-xs text-ink-muted">{operatingModeLabel(selected.zone.mode)}</span>
                  )}
                  {/*
                    #281 AC8 (#280 R8) — the per-record cross-view link: THIS engineer, on the sibling
                    view that answers the present-tense question. It states the question it moves to,
                    because a link between a projection and a commitment that did not would re-create
                    the confusion #280 R2 is about, one screen smaller.
                  */}
                  <span data-testid="preview-to-schedule" className="ml-auto text-xs">
                    <Link to={`/schedules/${selected.entry.seId}`} className="text-link hover:underline">
                      See what is actually committed for them today →
                    </Link>
                  </span>
                </div>
                {selected.entry.plants.map((stop, i) => (
                  <div key={stop.plantId} className="mb-3 rounded-md border border-line">
                    <div className="border-b border-line px-3 py-2 text-sm text-ink">
                      <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-alt text-xs">
                        {i + 1}
                      </span>
                      {plantLabel(stop.plantId)}
                      <span className="ml-2 text-xs text-ink-muted">
                        {stop.ticketIds.length} ticket{stop.ticketIds.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <ul>
                      {stop.ticketIds.map((ticketId) => {
                        const d = decisionsByTicket.get(ticketId);
                        return (
                          <li
                            key={ticketId}
                            data-testid={`preview-ticket-${ticketId}`}
                            className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
                          >
                            {/* #281 AC10 — a truncated uuid is not an identifier an operator can act
                                on. The full id rides the accessible name, and the row opens the
                                ticket rather than asking them to copy eight characters somewhere. */}
                            <Link
                              to={`/tickets/${ticketId}`}
                              aria-label={`Open ticket ${ticketId}`}
                              title={ticketId}
                              className="font-mono text-xs text-link hover:underline"
                            >
                              {ticketId.slice(0, 8)}
                            </Link>
                            {d?.deviceBucket && <SLABadge bucket={d.deviceBucket} />}
                            {d?.companyTier && <TierBadge tier={d.companyTier} />}
                            {d?.plannerBias && <Badge tone="info">Planner</Badge>}
                            <span className="ml-auto">
                              <Button variant="secondary" onClick={() => doHold(ticketId)}>
                                Hold
                              </Button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </>
            ) : (
              <p className="text-sm text-ink-muted">Select a Service Engineer to see their projected stops.</p>
            )}
          </div>
        </div>
      )}

      {/* Holds are shown even when they exclude every ticket, so a hold is never invisible. */}
      {preview && preview.holds.length > 0 && (
        <div className="mt-6 rounded-lg border border-line bg-surface" data-testid="preview-holds">
          <div className="border-b border-line px-3 py-2 text-xs uppercase tracking-wide text-ink-muted">
            Holds in force for {preview.targetDate}
          </div>
          <ul>
            {preview.holds.map((h: HoldInForce) => (
              <li key={h.ticketId} className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                <Link
                  to={`/tickets/${h.ticketId}`}
                  aria-label={`Open ticket ${h.ticketId}`}
                  title={h.ticketId}
                  className="font-mono text-xs text-link hover:underline"
                >
                  {h.ticketId.slice(0, 8)}
                </Link>
                <span className="text-xs text-ink-muted">{formatPlantDisplayName(h.plantName) || h.plantName}</span>
                <span className="text-xs text-ink-muted">returns {h.heldUntil}</span>
                <span className="ml-auto">
                  <Button variant="secondary" onClick={() => doRelease(h.ticketId)}>
                    Release
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unassignable tickets are surfaced, never dropped — they are a coverage/capacity failure. */}
      {zones.some((z: ZoneProjection) => z.unassignable > 0) && (
        <div className="mt-6 rounded-lg border border-line bg-surface p-3 text-sm text-ink" data-testid="preview-unassignable">
          {zones.reduce((n, z) => n + z.unassignable, 0)} ticket(s) would find no eligible SE. These are a
          coverage or capacity gap to act on — unlike withheld tickets, which are the configured policy
          working as intended.
        </div>
      )}
    </div>
  );
}
