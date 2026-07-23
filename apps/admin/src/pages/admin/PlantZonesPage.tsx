import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearPlantZoneOverride,
  getZoneChangeImpact,
  listPlantZoneOverrides,
  reapplyZoneMappings,
  setPlantZoneOverride,
  type PlantZoneOverrideRow,
  type ReapplyResult,
  type ZoneChangeImpact,
} from '../../api/plantZones';
import { listPlants, listZones, type PlantView, type ZoneView } from '../../api/org';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { Modal } from '../../components/overlay';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

const UNZONED = 'UNZONED';

/**
 * Plant Zones (#158, Operations Head). Surfaces the `plant_zone_overrides` mechanism that until now
 * was API-only — the same plumbing that pinned 47 plants and cut UNZONED devices from 83% to 23%.
 *
 * Two behaviours are load-bearing and deliberate:
 * - Every set/clear is followed by `reapply`, because master sync is insert-only on `plants.zone_id`:
 *   the override alone would sit there changing nothing. The reapply counts are shown as the receipt.
 * - A reason is mandatory. Re-pinning UPSERTS the single row per plant, so the previous zone and
 *   reason are overwritten — `audit_logs` is the only place the history survives.
 */
export function PlantZonesPage() {
  const [plants, setPlants] = useState<PlantView[]>([]);
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [overrides, setOverrides] = useState<PlantZoneOverrideRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unzonedOnly, setUnzonedOnly] = useState(false);
  const [reapplyResult, setReapplyResult] = useState<ReapplyResult | null>(null);
  const [changeTarget, setChangeTarget] = useState<PlantView | null>(null);
  const [clearTarget, setClearTarget] = useState<PlantView | null>(null);

  const load = useCallback(() => {
    Promise.all([listPlants(), listZones(), listPlantZoneOverrides()])
      .then(([p, z, o]) => {
        setPlants(p);
        setZones(z);
        setOverrides(o);
      })
      .catch(() => setError('Failed to load plant zones'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const overrideBySourceId = useMemo(
    () => new Map(overrides.map((o) => [o.sourcePlantId, o])),
    [overrides],
  );

  // Only AutoPlant-synced plants can be pinned — the override table keys on source_plant_id.
  const rows = useMemo(() => {
    const synced = plants.filter((p) => p.sourcePlantId != null);
    return unzonedOnly ? synced.filter((p) => p.zoneName === UNZONED) : synced;
  }, [plants, unzonedOnly]);

  const afterWrite = (result: ReapplyResult) => {
    setReapplyResult(result);
    setChangeTarget(null);
    setClearTarget(null);
    load();
  };

  const columns: Column<PlantView>[] = [
    { key: 'plant', header: 'Plant', render: (p) => p.name },
    { key: 'sourcePlantId', header: 'source_plant_id', render: (p) => p.sourcePlantId ?? '—' },
    {
      key: 'sourceZoneName',
      header: 'AutoPlant zone',
      render: (p) => <span className="text-ink-muted">{p.sourceZoneName ?? '—'}</span>,
    },
    {
      key: 'zoneName',
      header: 'FSM zone',
      render: (p) =>
        p.zoneName === UNZONED ? (
          <Badge tone="warning">{UNZONED}</Badge>
        ) : (
          <span>{p.zoneName ?? '—'}</span>
        ),
    },
    {
      key: 'override',
      header: 'Override',
      render: (p) => {
        const o = p.sourcePlantId ? overrideBySourceId.get(p.sourcePlantId) : undefined;
        if (!o) return <span className="text-ink-subtle">—</span>;
        return (
          <span className="flex flex-col gap-0.5">
            <Badge tone="brand" data-testid={`override-badge-${p.sourcePlantId}`}>
              Pinned to {o.fsmZoneName ?? o.fsmZoneId}
            </Badge>
            {o.reason && <span className="text-xs text-ink-subtle">{o.reason}</span>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (p) => (
        <span className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid={`change-zone-${p.sourcePlantId}`}
            onClick={() => setChangeTarget(p)}
          >
            Change zone
          </Button>
          {p.sourcePlantId && overrideBySourceId.has(p.sourcePlantId) && (
            <Button
              variant="secondary"
              size="sm"
              data-testid={`clear-override-${p.sourcePlantId}`}
              onClick={() => setClearTarget(p)}
            >
              Clear override
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Plant Zones"
        subtitle="Pin a plant to an FSM zone when AutoPlant's zone name is missing or wrong. A pin outranks the zone crosswalk and survives master sync. Its devices and open tickets move to the new zone's queues immediately."
        actions={
          <Button
            variant={unzonedOnly ? 'primary' : 'secondary'}
            data-testid="filter-unzoned"
            onClick={() => setUnzonedOnly((v) => !v)}
          >
            {unzonedOnly ? 'Showing UNZONED only' : 'Show UNZONED only'}
          </Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      {reapplyResult && (
        <div
          data-testid="reapply-result"
          className="mb-4 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm"
        >
          Re-applied zone resolution across {reapplyResult.plantsConsidered.toLocaleString()} plants:{' '}
          <strong>
            {reapplyResult.updated.toLocaleString()} plant{reapplyResult.updated === 1 ? '' : 's'} moved
          </strong>
          , {reapplyResult.unchanged.toLocaleString()} unchanged, {reapplyResult.landedUnzoned.toLocaleString()}{' '}
          still UNZONED.
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(p) => String(p.plantId)}
        rowTestId={(p) => `plant-zone-row-${p.sourcePlantId}`}
        ariaLabel="Plant zones"
        empty={<EmptyState message="No AutoPlant-synced plants to show." />}
      />

      {changeTarget && (
        <ChangeZoneDialog
          plant={changeTarget}
          zones={zones}
          onClose={() => setChangeTarget(null)}
          onDone={afterWrite}
        />
      )}

      {clearTarget && (
        <ClearOverrideDialog
          plant={clearTarget}
          onClose={() => setClearTarget(null)}
          onDone={afterWrite}
        />
      )}
    </section>
  );
}

function ChangeZoneDialog({
  plant,
  zones,
  onClose,
  onDone,
}: {
  plant: PlantView;
  zones: ZoneView[];
  onClose: () => void;
  onDone: (r: ReapplyResult) => void;
}) {
  const [zoneId, setZoneId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [impact, setImpact] = useState<ZoneChangeImpact | null>(null);

  useEffect(() => {
    let live = true;
    getZoneChangeImpact(plant.sourcePlantId!)
      .then((i) => live && setImpact(i))
      .catch(() => undefined); // the blast-radius read is advisory; never block the edit on it
    return () => {
      live = false;
    };
  }, [plant.sourcePlantId]);

  const submit = async () => {
    if (!zoneId) {
      setErr('Pick a zone.');
      return;
    }
    if (!reason.trim()) {
      setErr('A reason is required — it is the only record of why this plant moved.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await setPlantZoneOverride(plant.sourcePlantId!, Number(zoneId), reason.trim());
      // The pin is inert until this runs — master sync never moves an existing plant's zone.
      onDone(await reapplyZoneMappings());
    } catch {
      setErr('Zone change failed — please try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Change zone for ${plant.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="confirm-zone-change" loading={busy} onClick={submit}>
            Change zone
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-ink-muted">
        This plant is currently in <strong>{plant.zoneName ?? '—'}</strong>; AutoPlant calls its zone{' '}
        <strong>{plant.sourceZoneName ?? '—'}</strong>. Pinning outranks the crosswalk and survives
        master sync. The plant's devices and open tickets move to the new zone's queues immediately.
      </p>
      {impact && (
        <div data-testid="zone-change-impact" className="mb-3 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm">
          Moving this plant re-scopes <strong>{impact.deviceCount.toLocaleString()} devices</strong> and{' '}
          <strong>{impact.openTicketCount.toLocaleString()} open tickets</strong> to the new zone's
          dashboards and queues immediately.
        </div>
      )}

      {impact != null && impact.dispatchedTodayCount > 0 && (
        <div
          data-testid="mid-day-move-warning"
          role="alert"
          className="mb-3 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          {impact.dispatchedTodayCount} of this plant's tickets are already on a dispatched day plan
          today. Those tickets will move with the plant, but the day plan itself stays under{' '}
          <strong>{impact.currentZoneName ?? '—'}</strong> — the zone it was dispatched in. Until
          tomorrow's run, one ZM holds the plan and the other sees the tickets.
        </div>
      )}

      <label className="mb-1 block text-xs font-medium text-ink-subtle" htmlFor="plant-zone-select">
        Zone
      </label>
      <select
        id="plant-zone-select"
        data-testid="zone-select"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        value={zoneId}
        onChange={(e) => setZoneId(e.target.value)}
      >
        <option value="">Select a zone…</option>
        {zones.map((z) => (
          <option key={z.zoneId} value={String(z.zoneId)}>
            {z.name}
          </option>
        ))}
      </select>
      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle" htmlFor="plant-zone-reason">
        Reason
      </label>
      <textarea
        id="plant-zone-reason"
        data-testid="reason-input"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        rows={3}
        placeholder="Why is this plant moving zone?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {err && (
        <p className="mt-2 text-sm text-critical" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}

function ClearOverrideDialog({
  plant,
  onClose,
  onDone,
}: {
  plant: PlantView;
  onClose: () => void;
  onDone: (r: ReapplyResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await clearPlantZoneOverride(plant.sourcePlantId!);
      onDone(await reapplyZoneMappings());
    } catch {
      setErr('Clearing the override failed — please try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Clear the zone override on ${plant.name}?`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="confirm-clear-override" loading={busy} onClick={confirm}>
            Clear override
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-muted">
        The plant falls back to the zone crosswalk on AutoPlant's <strong>{plant.sourceZoneName ?? '—'}</strong>,
        landing in UNZONED if that value is still unmapped.
      </p>
      {err && (
        <p className="mt-2 text-sm text-critical" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}
