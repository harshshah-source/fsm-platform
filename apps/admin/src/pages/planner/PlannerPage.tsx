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

/**
 * SE Planner grid (Issue 14b, ADR-0022). The Zonal-Manager plant-visit scheduling tool — separate from
 * the Day Plan (CONTEXT §SE Planner): rows are the zone's SEs, columns are days across a flexible
 * multi-day window (Schedule Cadence), and each cell holds the plant-visit intents the ZM wants that SE
 * to cover. Intents are a soft bias to the Morning Batch (Issue 14a), not a hard assignment — they
 * surface alongside each SE's Batch Schedule and stay overridable at the Schedule level (Issue 13b).
 *
 * Assign a plant to a cell by selecting it in the picker and dropping it on (or clicking) the cell;
 * remove via the chip's ×. Writes go straight to POST/DELETE /api/planner and the grid refetches, so it
 * always reflects persisted state. Zone scope is enforced server-side (a ZM sees only their own zone).
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

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">SE Planner</h2>
      <p className="mb-4 text-sm text-slate-500">
        Plant-visit intent for {dateFrom} – {dateTo}. Soft bias to the Morning Batch — overridable on the
        Batch Schedule.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* Plant picker — pick a plant, then drop it on (or click) a cell to assign it as an intent. */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <label htmlFor="planner-plant" className="text-slate-600">
          Plant to assign
        </label>
        <select
          id="planner-plant"
          aria-label="Plant to assign"
          value={selectedPlantId}
          onChange={(e) => setSelectedPlantId(e.target.value)}
          className="rounded border px-2 py-1"
        >
          <option value="">Select a plant…</option>
          {plants.map((p) => (
            <option key={p.plantId} value={p.plantId}>
              {p.name}
            </option>
          ))}
        </select>
        {selectedPlantId && (
          <span
            draggable
            data-testid="plant-drag-source"
            onDragStart={(e) => e.dataTransfer.setData('text/plant-id', selectedPlantId)}
            className="cursor-grab rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800"
          >
            {plantName(selectedPlantId)}
          </span>
        )}
      </div>

      <table aria-label="SE Planner grid" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Engineer</th>
            <th className="py-2 pr-3">Batch Schedule</th>
            {days.map((d) => (
              <th key={d} className="py-2 px-2 font-medium">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {engineers.map((eng) => {
            const sched = scheduleFor(eng.engineerId);
            return (
              <tr key={eng.engineerId} className="border-b align-top">
                <td className="py-2 pr-3 font-medium text-slate-700">{eng.engineerId}</td>
                <td className="py-2 pr-3" data-testid={`batch-${eng.engineerId}`}>
                  {sched ? (
                    <span
                      data-testid={`batch-status-${eng.engineerId}`}
                      className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                    >
                      {sched.status} · {sched.ticketCount} tickets
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">No batch</span>
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
                    className="min-w-[7rem] border-l p-1 align-top"
                  >
                    <div className="flex flex-col gap-1">
                      {cellEntries(eng.engineerId, d).map((entry) => (
                        <span
                          key={entry.id}
                          data-testid={`intent-${entry.id}`}
                          className="flex items-center justify-between gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800"
                        >
                          {plantName(entry.plantId)}
                          <button
                            type="button"
                            aria-label={`Remove ${plantName(entry.plantId)}`}
                            onClick={() => void remove(entry.id)}
                            className="text-emerald-700 hover:text-red-700"
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
                        className="rounded border border-dashed px-1 text-xs text-slate-400 hover:text-slate-600 disabled:opacity-40"
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
  );
}
