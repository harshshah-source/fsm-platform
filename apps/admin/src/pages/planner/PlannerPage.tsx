import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiCreatePlannerEntry,
  apiDeletePlannerEntry,
  apiListPlannerEntries,
  apiListPlannerPlants,
  type PlannerEntry,
  type PlannerPlant,
} from '../../api/planner';
import { apiListSchedules, apiZoneEngineers, type ScheduleRow, type ZoneEngineer } from '../../api/schedules';
import { DateRangeChips, FilterSelect, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/cn';

/**
 * SE Planner grid (Issue 14b · FE-11 parity, reference 16, ADR-0022). The Zonal-Manager plant-visit
 * scheduling tool — separate from the Day Plan (CONTEXT §SE Planner): rows are the zone's SEs, columns
 * are days across a flexible multi-day window (Schedule Cadence), and each cell holds the plant-visit
 * intents the ZM wants that SE to cover. Intents are a soft bias to the Morning Batch (Issue 14a), not a
 * hard assignment — they surface alongside each SE's Batch Schedule and stay overridable (Issue 13b).
 *
 * Assign a plant to a cell by selecting it in the picker and dropping it on (or clicking) the cell;
 * remove via the chip's ×. Writes go straight to POST/DELETE /api/planner and the grid refetches, so it
 * always reflects persisted state. Zone scope is enforced server-side (a ZM sees only their own zone).
 *
 * FE-11 is a presentation-only refactor: the bespoke drag-drop grid is re-skinned onto the design tokens
 * + KPI `MetricStrip` + coverage column, but every test id, the drag/drop dataTransfer contract, the
 * `SE Planner grid` aria-label, and the CRUD calls are preserved.
 */
const WINDOW_DAYS = 7;

/** Local-time YYYY-MM-DD (avoids the UTC shift that `toISOString` would introduce near midnight). */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildWindow(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return isoDate(d);
  });
}

export function PlannerPage() {
  const days = useMemo(() => buildWindow(new Date(), WINDOW_DAYS), []);
  const dateFrom = days[0];
  const dateTo = days[days.length - 1];

  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [plants, setPlants] = useState<PlannerPlant[]>([]);
  const [entries, setEntries] = useState<PlannerEntry[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [selectedPlantId, setSelectedPlantId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refetchEntries = useCallback(() => {
    return apiListPlannerEntries(dateFrom, dateTo).then(setEntries);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiZoneEngineers(),
      apiListPlannerPlants(),
      apiListPlannerEntries(dateFrom, dateTo),
      apiListSchedules().catch(() => [] as ScheduleRow[]),
    ])
      .then(([eng, pl, ent, sch]) => {
        if (!alive) return;
        setEngineers(eng);
        setPlants(pl);
        setEntries(ent);
        setSchedules(sch);
      })
      .catch(() => alive && setError('Failed to load planner'));
    return () => {
      alive = false;
    };
  }, [dateFrom, dateTo]);

  const plantName = useCallback(
    (plantId: string) => plants.find((p) => p.plantId === plantId)?.name ?? `Plant ${plantId}`,
    [plants],
  );

  const cellEntries = useCallback(
    (seId: string, date: string) => entries.filter((e) => e.seId === seId && e.plannedDate === date),
    [entries],
  );

  const scheduleFor = useCallback(
    (seId: string) => schedules.find((s) => s.seId === seId) ?? null,
    [schedules],
  );

  async function assign(seId: string, plannedDate: string, plantId: string) {
    if (!plantId) return;
    try {
      await apiCreatePlannerEntry({ seId, plantId, plannedDate });
      await refetchEntries();
    } catch {
      setError('Failed to save plant intent');
    }
  }

  async function remove(id: string) {
    try {
      await apiDeletePlannerEntry(id);
      await refetchEntries();
    } catch {
      setError('Failed to remove plant intent');
    }
  }

  const metrics: Metric[] = useMemo(() => {
    const plannedSes = new Set(entries.map((e) => e.seId)).size;
    return [
      { label: 'Engineers', value: engineers.length, hint: 'in zone scope', tone: 'info' },
      { label: 'Plant Intents', value: entries.length, hint: `${dateFrom} – ${dateTo}`, tone: 'success' },
      { label: 'Planned SEs', value: plannedSes, hint: 'with ≥1 intent', tone: 'brand' },
      { label: 'Window', value: `${WINDOW_DAYS}d`, hint: 'schedule cadence', tone: 'neutral' },
    ];
  }, [engineers, entries, dateFrom, dateTo]);

  const th =
    'whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-caps';

  return (
    <div>
      <PageHeader
        title="SE Planner"
        subtitle={`Plant-visit intent for ${dateFrom} – ${dateTo}. Soft bias to the Morning Batch — overridable on the Batch Schedule.`}
        actions={<DateRangeChips />}
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} />

      {/* Plant picker — pick a plant, then drop it on (or click) a cell to assign it as an intent. */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <label htmlFor="planner-plant" className="text-ink-muted">
          Plant to assign
        </label>
        <FilterSelect
          id="planner-plant"
          aria-label="Plant to assign"
          value={selectedPlantId}
          onChange={(e) => setSelectedPlantId(e.target.value)}
        >
          <option value="">Select a plant…</option>
          {plants.map((p) => (
            <option key={p.plantId} value={p.plantId}>
              {p.name}
            </option>
          ))}
        </FilterSelect>
        {selectedPlantId && (
          <span
            draggable
            data-testid="plant-drag-source"
            onDragStart={(e) => e.dataTransfer.setData('text/plant-id', selectedPlantId)}
            className="cursor-grab rounded-full bg-info-bg px-2 py-0.5 text-xs font-medium text-info"
          >
            {plantName(selectedPlantId)}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        <div className="overflow-x-auto">
          <table aria-label="SE Planner grid" className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className={th}>Engineer</th>
                <th className={th}>Coverage</th>
                <th className={th}>Batch Schedule</th>
                {days.map((d) => (
                  <th key={d} className={cn(th, 'text-center font-medium')}>
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {engineers.map((eng) => {
                const sched = scheduleFor(eng.engineerId);
                return (
                  <tr key={eng.engineerId} className="border-b border-line align-top last:border-b-0">
                    <td className="px-3 py-2.5 font-medium text-ink-strong">{eng.engineerId}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone="neutral">{eng.coverageType}</Badge>
                    </td>
                    <td className="px-3 py-2.5" data-testid={`batch-${eng.engineerId}`}>
                      {sched ? (
                        <span data-testid={`batch-status-${eng.engineerId}`}>
                          <Badge tone="info">
                            {sched.status} · {sched.ticketCount} tickets
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-muted">No batch</span>
                      )}
                    </td>
                    {days.map((d) => (
                      <td
                        key={d}
                        data-testid={`cell-${eng.engineerId}-${d}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const dropped = e.dataTransfer.getData('text/plant-id') || selectedPlantId;
                          void assign(eng.engineerId, d, dropped);
                        }}
                        className="min-w-[7rem] border-l border-line p-1.5 align-top"
                      >
                        <div className="flex flex-col gap-1">
                          {cellEntries(eng.engineerId, d).map((entry) => (
                            <span
                              key={entry.id}
                              data-testid={`intent-${entry.id}`}
                              className="flex items-center justify-between gap-1 rounded-md bg-success-bg px-1.5 py-0.5 text-xs font-medium text-success"
                            >
                              {plantName(entry.plantId)}
                              <button
                                type="button"
                                aria-label={`Remove ${plantName(entry.plantId)}`}
                                onClick={() => void remove(entry.id)}
                                className="text-success hover:text-critical"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <button
                            type="button"
                            aria-label={`Add plant to ${eng.engineerId} on ${d}`}
                            disabled={!selectedPlantId}
                            onClick={() => void assign(eng.engineerId, d, selectedPlantId)}
                            className="rounded-md border border-dashed border-line px-1 text-xs text-ink-muted hover:text-ink-strong disabled:opacity-40"
                          >
                            + add
                          </button>
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
