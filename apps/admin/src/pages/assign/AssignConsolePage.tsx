import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiAssignableWork,
  type AssignablePlantRow,
  type AssignableWorkView,
} from '../../api/assignWork';
import { apiAssignPlants, apiZoneEngineers, type ZoneEngineer } from '../../api/schedules';
import { MetricStrip, PageHeader, SearchInput, type Metric } from '../../components/data';
import { Badge, Button, LoadBadge } from '../../components/ui';
import { engineerOptionLabel } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';

/**
 * **Assign work** — the manual-assignment console (#273, approved direction #272; the authoritative
 * design is `docs/ui/desktop/approved-designs/assign-work-console.html`).
 *
 * Seven surfaces in this app could already move work to an engineer and **not one showed a count**:
 * the volume arrived afterwards, in a toast. Each is shaped N→1 — many tickets, one engineer, written
 * immediately, no preview and no residual — while a dispatcher's job is M→N. This is the M→N surface,
 * and the ledger across the top is the answer none of the seven could give: *how much is left?*
 *
 * **Nothing is written until commit (#272 R2).** That is what makes the residual live rather than
 * retrospective, and it is why the draft is client state and the ledger is arithmetic rather than a
 * second read.
 *
 * **The draft is session-local (#272 Q2, ruled).** Leaving the page loses it, and the page says so
 * rather than implying a durability it does not have. A shared, resumable draft needs its own table,
 * an owner and a staleness rule for when the underlying tickets move; that is not v1.
 *
 * **Slice 1 of five.** The candidate column (#274), the transactional `assign-batch` write (#275),
 * Distribute (#276) and the absorbed orphan surfaces (#277) follow. What is here is usable on its own:
 * see the pool, draft against it, watch the residual, commit.
 */

/** The unit of selection. A plant serves several companies, so neither id alone identifies a row. */
const rowKey = (companyId: string, plantId: string) => `${companyId}:${plantId}`;

interface Lane {
  id: number;
  seId: string;
  /** Plant ids, deduplicated — the write's unit (see {@link plantTotals}). */
  plantIds: string[];
}

/**
 * Every company row folded down to the **plant**, because `assignPlants` is plant-shaped: it moves all
 * of a plant's assignable work regardless of which company's row was ticked.
 *
 * This is the slice's one sharp edge and it is surfaced rather than hidden. Drafting UltraTech's 4
 * devices at a site it shares with Acme commits Acme's 6 as well, so the ledger has to count 10 — a
 * draft that counted only the ticked row would under-report its own commit, which is the failure R3
 * exists to prevent, reappearing one layer up. Ticket-level selection arrives with #275's
 * `assign-batch`; until then the honest move is to count what the button does and say why.
 */
function plantTotals(view: AssignableWorkView | null) {
  const totals = new Map<string, { openUnassigned: number; criticalCount: number; companies: Set<string> }>();
  for (const c of view?.companies ?? []) {
    for (const p of c.plants) {
      const entry = totals.get(p.plantId) ?? { openUnassigned: 0, criticalCount: 0, companies: new Set<string>() };
      entry.openUnassigned += p.openUnassigned;
      entry.criticalCount += p.criticalCount;
      entry.companies.add(c.companyId);
      totals.set(p.plantId, entry);
    }
  }
  return totals;
}

/** `61 h silent` / `—` — the age of the oldest thing waiting at a site. */
function silentFor(hours: number | null): string | null {
  return hours === null ? null : `oldest ${Math.round(hours)} h silent`;
}

export function AssignConsolePage() {
  const [view, setView] = useState<AssignableWorkView | null>(null);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One empty lane from the start. A console that opens with no lane offers a pool you can tick and
  // nowhere to put it — a dead end on the first screen, and the dispatcher always needs at least one.
  const [lanes, setLanes] = useState<Lane[]>([{ id: 1, seId: '', plantIds: [] }]);
  const [nextLaneId, setNextLaneId] = useState(2);
  const [committing, setCommitting] = useState(false);
  const [results, setResults] = useState<{ seId: string; ok: boolean; assigned: number; message?: string }[] | null>(null);

  const load = useCallback(() => {
    let alive = true;
    apiAssignableWork()
      .then((v) => alive && setView(v))
      .catch(() => alive && setError('Failed to load the work pool'));
    apiZoneEngineers()
      .then((e) => alive && setEngineers(e))
      .catch(() => alive && setEngineers([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const totals = useMemo(() => plantTotals(view), [view]);

  /** Plants already drafted, across every lane — a plant cannot be handed to two engineers. */
  const drafted = useMemo(() => new Set(lanes.flatMap((l) => l.plantIds)), [lanes]);

  const inDraft = useMemo(() => {
    let open = 0;
    let critical = 0;
    for (const plantId of drafted) {
      const t = totals.get(plantId);
      if (!t) continue;
      open += t.openUnassigned;
      critical += t.criticalCount;
    }
    return { open, critical };
  }, [drafted, totals]);

  const openTotal = view?.totals.openUnassigned ?? 0;

  const metrics: Metric[] = [
    { label: 'Open unassigned', value: openTotal, hint: view ? `zone scope · ${view.date}` : '—', tone: 'info', testId: 'ledger-open' },
    { label: 'In this draft', value: inDraft.open, hint: `${drafted.size} plants · ${lanes.length} engineers`, tone: 'brand', testId: 'ledger-draft' },
    {
      label: 'Left after commit',
      value: openTotal - inDraft.open,
      hint: openTotal > 0 ? `${Math.round(((openTotal - inDraft.open) / openTotal) * 100)}% still unassigned` : 'nothing outstanding',
      tone: 'neutral',
      testId: 'ledger-left',
    },
    {
      label: 'Critical+ in draft',
      value: inDraft.critical,
      hint: `of ${view?.totals.criticalCount ?? 0} in zone`,
      tone: inDraft.critical > 0 ? 'critical' : 'neutral',
      testId: 'ledger-critical',
    },
  ];

  const matches = (company: string, plant: AssignablePlantRow) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return company.toLowerCase().includes(term) || plant.plantName.toLowerCase().includes(term);
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Move the ticked rows into a lane, as plants — the unit the commit will use. */
  const addToDraft = (laneId: number) => {
    const plantIds = [...selected].map((k) => k.split(':')[1]);
    setLanes((prev) =>
      prev.map((l) =>
        l.id === laneId ? { ...l, plantIds: [...new Set([...l.plantIds, ...plantIds])] } : l,
      ),
    );
    setSelected(new Set());
  };

  const addLane = () => {
    setLanes((prev) => [...prev, { id: nextLaneId, seId: '', plantIds: [] }]);
    setNextLaneId((n) => n + 1);
  };

  /**
   * Commit: one `apiAssignPlants` per lane, sequentially, reporting per lane.
   *
   * Deliberately the **existing** endpoint — #275 replaces it with a transactional `assign-batch`,
   * and blocking a usable console on that rewrite would leave the seven scattered surfaces as the only
   * way to assign for another two slices. The per-lane result shape is already what `assign-batch`
   * returns, so the swap is behind this function.
   *
   * Lanes are independent: one failing does not report the others as failed, and does not stop them.
   * That is the honest reading of a per-engineer write, and it is what #275 formalises.
   */
  const commit = async () => {
    setCommitting(true);
    const out: { seId: string; ok: boolean; assigned: number; message?: string }[] = [];
    for (const lane of lanes) {
      if (!lane.seId || lane.plantIds.length === 0) continue;
      try {
        const summary = await apiAssignPlants(lane.seId, lane.plantIds);
        out.push({ seId: lane.seId, ok: true, assigned: summary.assigned });
      } catch {
        out.push({ seId: lane.seId, ok: false, assigned: 0, message: 'Assignment failed for this engineer' });
      }
    }
    setResults(out);
    setLanes([{ id: nextLaneId, seId: '', plantIds: [] }]);
    setCommitting(false);
    load();
  };

  const engineerName = (seId: string) => engineers.find((e) => e.engineerId === seId)?.name ?? seId;
  const readyLanes = lanes.filter((l) => l.seId && l.plantIds.length > 0);

  return (
    <div>
      <PageHeader
        title="Assign work"
        subtitle="Everything unassigned in your scope, what you are about to hand out, and what will be left. Nothing is written until you commit — this draft lives in this browser tab only."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------- Work pool ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Work pool">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Work pool</h2>
            <span className="text-xs text-ink-muted">{openTotal} unassigned</span>
          </header>

          <SearchInput
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company or plant…"
            aria-label="Search the work pool"
          />

          <div className="mt-3 space-y-4">
            {(view?.companies ?? []).map((company) => {
              const plants = company.plants.filter((p) => matches(company.companyName, p));
              if (plants.length === 0) return null;
              return (
                <div key={company.companyId}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-ink-strong">{company.companyName}</span>
                    <span className="text-ink-muted">
                      {plants.length} plants · {plants.reduce((n, p) => n + p.openUnassigned, 0)}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {plants.map((p) => {
                      const key = rowKey(company.companyId, p.plantId);
                      const shared = (totals.get(p.plantId)?.companies.size ?? 1) > 1;
                      const already = drafted.has(p.plantId);
                      const silent = silentFor(p.oldestInactivityHours);
                      return (
                        <li
                          key={key}
                          data-testid={`pool-plant-${company.companyId}-${p.plantId}`}
                          className={cn(
                            'flex items-start gap-2 rounded-md border border-line px-2 py-1.5 text-sm',
                            selected.has(key) && 'bg-brand-300/20',
                            already && 'opacity-60',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`Select ${p.plantName} for ${company.companyName}`}
                            checked={selected.has(key)}
                            disabled={p.openUnassigned === 0 || already}
                            onChange={() => toggle(key)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink-strong">
                              {formatPlantDisplayName(p.plantName)}
                            </span>
                            <span className="block text-[11px] text-ink-muted">
                              {silent ?? 'age not recorded'}
                              {/* The plant-shaped commit, said out loud on the row it applies to. */}
                              {shared && ' · serves 2 companies — all of its unassigned work moves together'}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-right">
                            <span className="tabular-nums font-semibold text-ink-strong">{p.openUnassigned}</span>
                            <span className="tabular-nums text-[11px] text-ink-muted">/ {p.totalDevices}</span>
                            {p.criticalCount > 0 && <Badge tone="critical">{p.criticalCount} crit</Badge>}
                            {p.heldCount > 0 && <Badge tone="warning">{p.heldCount} held</Badge>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {view && view.companies.length === 0 && (
              <p className="text-sm text-ink-muted">Nothing unassigned in your scope right now.</p>
            )}
          </div>
        </section>

        {/* ---------------- Draft plan ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Draft plan">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Draft plan</h2>
            <span className="text-xs text-ink-muted">{inDraft.open === 0 ? 'nothing written yet' : `${inDraft.open} devices`}</span>
          </header>

          <div className="space-y-2">
            {lanes.map((lane) => {
              const eng = engineers.find((e) => e.engineerId === lane.seId);
              return (
                <div key={lane.id} data-testid={`lane-${lane.id}`} className="rounded-md border border-line p-2">
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Engineer for lane ${lane.id}`}
                      value={lane.seId}
                      onChange={(e) =>
                        setLanes((prev) => prev.map((l) => (l.id === lane.id ? { ...l, seId: e.target.value } : l)))
                      }
                      className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-xs"
                    >
                      <option value="">Select engineer…</option>
                      {engineers.map((e) => (
                        <option key={e.engineerId} value={e.engineerId}>
                          {engineerOptionLabel(e)}
                        </option>
                      ))}
                    </select>
                    {eng && (
                      <LoadBadge seId={eng.engineerId} committed={eng.committed ?? 0} dailyCapacity={eng.dailyCapacity} />
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {lane.plantIds.map((plantId) => {
                      const t = totals.get(plantId);
                      const name =
                        view?.companies.flatMap((c) => c.plants).find((p) => p.plantId === plantId)?.plantName ??
                        `Plant ${plantId}`;
                      return (
                        <span
                          key={plantId}
                          data-testid={`chip-${lane.id}-${plantId}`}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px]"
                        >
                          {formatPlantDisplayName(name)}
                          <span className="tabular-nums text-ink-muted">×{t?.openUnassigned ?? 0}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${name} from lane ${lane.id}`}
                            onClick={() =>
                              setLanes((prev) =>
                                prev.map((l) =>
                                  l.id === lane.id ? { ...l, plantIds: l.plantIds.filter((p) => p !== plantId) } : l,
                                ),
                              )
                            }
                            className="text-ink-muted hover:text-critical"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => addToDraft(lane.id)}>
                      Add to draft
                    </Button>
                  </div>
                </div>
              );
            })}

            <Button size="sm" variant="ghost" onClick={addLane}>
              + Add engineer lane
            </Button>
          </div>

          {results && (
            <div className="mt-3 space-y-1" data-testid="commit-results">
              {results.map((r) => (
                <p key={r.seId} data-testid={`result-${r.seId}`} className="text-xs">
                  <span className="font-medium text-ink-strong">{engineerName(r.seId)}</span>{' '}
                  {r.ok ? (
                    <span className="text-success">assigned {r.assigned}</span>
                  ) : (
                    <span className="text-critical">{r.message}</span>
                  )}
                </p>
              ))}
            </div>
          )}
        </section>

        {/* ---------------- Candidates (#274) ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Candidates">
          <header className="mb-2">
            <h2 className="text-sm font-semibold text-ink-strong">Candidates</h2>
          </header>
          {/* Not a placeholder for its own sake: the column is in the approved design and #274 owns it
              (ordered candidates, dropped ones shown with their reason, coverage per engineer+plant).
              Saying which slice it belongs to beats a blank third of the screen. */}
          <p className="text-xs text-ink-muted">
            Engineer ranking for the selected plant — who covers it, in what tier, and why anyone was
            dropped — arrives with the next slice. Until then, pick the engineer on the lane.
          </p>
        </section>
      </div>

      <footer className="mt-4 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-card p-3 text-sm">
        <span>
          <b className="text-ink-strong">{inDraft.open} devices</b> → {readyLanes.length} engineers ·{' '}
          {drafted.size} plants
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={drafted.size === 0}
            onClick={() => setLanes([{ id: nextLaneId, seId: '', plantIds: [] }])}
          >
            Clear draft
          </Button>
          <Button size="sm" disabled={readyLanes.length === 0 || committing} loading={committing} onClick={() => void commit()}>
            Commit
          </Button>
        </span>
      </footer>
    </div>
  );
}
