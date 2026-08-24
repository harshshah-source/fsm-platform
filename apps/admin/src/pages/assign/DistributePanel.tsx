import { useState } from 'react';
import {
  apiDistributePreview,
  type DistributeResult,
  type DistributeStrategy,
  type ZoneEngineer,
} from '../../api/schedules';
import { Badge, Button } from '../../components/ui';
import { engineerOptionLabel } from '../../lib/capacity';
import { formatPlantDisplayName } from '../../lib/plantNames';

const STRATEGIES: { value: DistributeStrategy; label: string; description: string }[] = [
  {
    value: 'COVERAGE_TIER',
    label: 'By coverage tier',
    description:
      'Strict DEDICATED → MULTI_PLANT → FLOATING, exactly as an automatic dispatch would choose. Leaves work unplaced rather than crossing a tier or exceeding capacity.',
  },
  {
    value: 'CAPACITY_HEADROOM',
    label: 'By capacity headroom',
    description:
      'Fills toward daily capacity, respecting tier order within each plant — the engineer with the most room goes first. May exceed capacity when the selection cannot be absorbed; stated, not blocked.',
  },
  {
    value: 'PLANT_WHOLE',
    label: 'Keep each plant whole',
    description: 'Never splits one plant across two engineers — the whole site goes to a single best-tier engineer.',
  },
];

/**
 * #276 — Distribute: several plants across several engineers, projected before anything enters the
 * draft. The three strategies are allocation policies over one shared eligibility read — never a
 * second copy of who is eligible or in what tier order.
 */
export function DistributePanel({
  plantIds,
  plantName,
  engineers,
  resolveTicketIds,
  onAddToDraft,
  onClose,
}: {
  /** The plants currently ticked in the work pool. */
  plantIds: string[];
  plantName: (plantId: string) => string;
  engineers: ZoneEngineer[];
  /** Resolve the ticked plants to the exact ticket ids the projection should run over (#275's seam). */
  resolveTicketIds: (plantIds: string[]) => Promise<string[]>;
  onAddToDraft: (result: DistributeResult) => void;
  onClose: () => void;
}) {
  const [selectedEngineers, setSelectedEngineers] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<DistributeStrategy>('COVERAGE_TIER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DistributeResult | null>(null);

  const toggleEngineer = (seId: string) =>
    setSelectedEngineers((prev) => {
      const next = new Set(prev);
      if (next.has(seId)) next.delete(seId);
      else next.add(seId);
      return next;
    });

  const preview = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const ticketIds = await resolveTicketIds(plantIds);
      if (ticketIds.length === 0) {
        setError('Nothing assignable at the selected plants.');
        return;
      }
      const out = await apiDistributePreview(ticketIds, [...selectedEngineers], strategy);
      setResult(out);
    } catch {
      setError('Could not build the projection — try again.');
    } finally {
      setLoading(false);
    }
  };

  const engineerName = (seId: string) => engineers.find((e) => e.engineerId === seId)?.name ?? seId;
  const placedTotal = result?.lanes.reduce((n, l) => n + l.plants.reduce((m, p) => m + p.ticketIds.length, 0), 0) ?? 0;

  return (
    <div
      role="dialog"
      aria-label="Distribute across selected engineers"
      data-testid="distribute-panel"
      className="mb-4 rounded-card border border-line bg-surface-card p-3"
    >
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink-strong">Distribute across selected engineers</h3>
        <span className="text-xs text-ink-muted">{plantIds.length} plants selected</span>
      </header>

      <div className="mb-3">
        <p className="mb-1 text-xs font-semibold text-ink-strong">Engineers</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Select engineers">
          {engineers.map((e) => (
            <label key={e.engineerId} className="flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={selectedEngineers.has(e.engineerId)}
                onChange={() => toggleEngineer(e.engineerId)}
              />
              {engineerOptionLabel(e)}
            </label>
          ))}
        </div>
      </div>

      <div className="mb-3">
        <p className="mb-1 text-xs font-semibold text-ink-strong">Strategy</p>
        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <label key={s.value} className="flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="distribute-strategy"
                className="mt-0.5"
                checked={strategy === s.value}
                onChange={() => setStrategy(s.value)}
              />
              <span>
                <span className="font-medium text-ink-strong">{s.label}</span>
                <span className="block text-ink-muted">{s.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-2 text-xs text-critical">
          {error}
        </p>
      )}

      <Button size="sm" disabled={selectedEngineers.size === 0 || loading} loading={loading} onClick={() => void preview()}>
        Preview distribution
      </Button>

      {result && (
        <div className="mt-3 space-y-2" data-testid="distribute-result">
          <p className="text-xs text-ink-muted">
            <b className="text-ink-strong">{placedTotal} devices</b> → {result.lanes.length} engineers
          </p>
          <ul className="space-y-1">
            {result.lanes.map((l) => {
              const count = l.plants.reduce((n, p) => n + p.ticketIds.length, 0);
              return (
                <li key={l.seId} data-testid={`distribute-lane-${l.seId}`} className="text-xs">
                  <span className="font-medium text-ink-strong">{engineerName(l.seId)}</span>{' '}
                  <span className="tabular-nums text-ink-muted">
                    {count} device{count === 1 ? '' : 's'} · {l.plants.map((p) => formatPlantDisplayName(plantName(p.plantId))).join(', ')}
                  </span>{' '}
                  {result.overCapacitySeIds.includes(l.seId) && <Badge tone="warning">over capacity — allowed</Badge>}
                </li>
              );
            })}
          </ul>
          {result.unplaced.length > 0 && (
            <div data-testid="distribute-unplaced" className="rounded-md border border-warning/40 bg-warning-bg p-2 text-xs text-warning">
              <b>{result.unplaced.length}</b> with no eligible engineer among your selection —{' '}
              {result.unplaced.filter((u) => u.reason === 'NO_COVERAGE').length} no coverage,{' '}
              {result.unplaced.filter((u) => u.reason === 'ALL_DROPPED').length} all dropped.
            </div>
          )}
          <div className="flex gap-2">
            {/*
              Enabled when the projection has *anything* to hand over — lanes **or** an unplaced
              remainder. Gating on lanes alone disabled this button in precisely the case the rail
              exists for: a selection nobody can cover places nothing, so the operator was shown the
              count here and then had no way to carry it into the draft. Observed live at 90 unplaced
              / 0 placed.
            */}
            <Button
              size="sm"
              disabled={result.lanes.length === 0 && result.unplaced.length === 0}
              onClick={() => onAddToDraft(result)}
            >
              {result.lanes.length === 0 ? 'Add unplaceable work to draft' : 'Add to draft'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}

      {!result && (
        <Button size="sm" variant="ghost" className="ml-2" onClick={onClose}>
          Cancel
        </Button>
      )}
    </div>
  );
}
