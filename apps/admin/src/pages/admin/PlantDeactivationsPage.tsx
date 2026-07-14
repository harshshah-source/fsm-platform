import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listPlantDeactivations,
  deactivatePlant,
  reactivatePlant,
  type PlantDeactivationRow,
} from '../../api/plantDeactivations';
import { listPlants, type PlantView } from '../../api/org';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { Modal } from '../../components/overlay';
import { Select } from '../../components/overlay/Select';
import { Button } from '../../components/ui/Button';

/**
 * Plant Deactivations (Issue 119, Operations Head). Lists plants currently deactivated (FSM-owned,
 * survives sync) with a Reactivate action, and a Deactivate flow (pick plant + mandatory reason).
 * Deactivating cancels the plant's open tickets server-side; reactivating lets the pipeline re-create
 * tickets for still-inactive devices on the next run.
 */
export function PlantDeactivationsPage() {
  const [rows, setRows] = useState<PlantDeactivationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<PlantDeactivationRow | null>(null);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const load = useCallback(() => {
    listPlantDeactivations()
      .then(setRows)
      .catch(() => setError('Failed to load plant deactivations'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<PlantDeactivationRow>[] = [
    { key: 'company', header: 'Company', render: (r) => r.company ?? '—' },
    { key: 'plant', header: 'Plant', render: (r) => r.plantName },
    { key: 'sourcePlantId', header: 'source_plant_id', render: (r) => r.sourcePlantId ?? '—' },
    { key: 'zone', header: 'Zone', render: (r) => r.zone ?? 'Unzoned' },
    { key: 'devices', header: 'Devices', align: 'right', render: (r) => r.deviceCount },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-ink-muted">{r.reason}</span> },
    {
      key: 'by',
      header: 'Deactivated by / on',
      render: (r) => (
        <span className="text-xs text-ink-subtle">
          {(r.deactivatedBy ?? 'system').slice(0, 8)} · {new Date(r.deactivatedAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) => (
        <Button variant="secondary" size="sm" data-testid={`reactivate-${r.plantId}`} onClick={() => setReactivateTarget(r)}>
          Reactivate
        </Button>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Plant Deactivations"
        subtitle="Plants marked retired/shut by Operations. Their devices leave eligibility, dashboard counts and dispatch, and their open tickets were cancelled. Reversible."
        actions={
          <Button data-testid="open-deactivate" onClick={() => setDeactivateOpen(true)}>
            Deactivate a plant
          </Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowTestId={(r) => `deactivation-${r.plantId}`}
        ariaLabel="Plant deactivations"
        empty={<EmptyState message="No plants are currently deactivated." />}
      />

      {reactivateTarget && (
        <ReactivateDialog
          row={reactivateTarget}
          onClose={() => setReactivateTarget(null)}
          onDone={() => {
            setReactivateTarget(null);
            load();
          }}
        />
      )}

      {deactivateOpen && (
        <DeactivateDialog
          onClose={() => setDeactivateOpen(false)}
          onDone={() => {
            setDeactivateOpen(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function ReactivateDialog({
  row,
  onClose,
  onDone,
}: {
  row: PlantDeactivationRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await reactivatePlant(row.plantId, reason.trim() || undefined);
      onDone();
    } catch {
      setErr('Reactivation failed — please try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reactivate ${row.plantName}?`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="confirm-reactivate" loading={busy} onClick={confirm}>
            Reactivate
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-muted">
        Tickets will be re-created for still-inactive devices on the next pipeline run. The plant
        re-enters eligibility, dashboard counts and dispatch immediately.
      </p>
      <textarea
        className="mt-3 w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        rows={2}
        placeholder="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {err && <p className="mt-2 text-sm text-critical">{err}</p>}
    </Modal>
  );
}

function DeactivateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [plants, setPlants] = useState<PlantView[]>([]);
  const [plantId, setPlantId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listPlants()
      .then(setPlants)
      .catch(() => setErr('Failed to load plants'));
  }, []);

  const options = useMemo(
    () => plants.map((p) => ({ value: String(p.plantId), label: `${p.name} (#${p.plantId})` })),
    [plants],
  );

  const submit = async () => {
    if (!plantId) {
      setErr('Pick a plant.');
      return;
    }
    if (!reason.trim()) {
      setErr('Reason is required.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await deactivatePlant(plantId, reason.trim());
      onDone();
    } catch {
      setErr('Deactivation failed — the plant may already be deactivated.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Deactivate a plant"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="confirm-deactivate" loading={busy} onClick={submit}>
            Deactivate
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-ink-muted">
        Deactivating cancels the plant’s open tickets and removes its devices from eligibility,
        dashboard counts and dispatch. Reversible.
      </p>
      <label className="mb-1 block text-xs font-medium text-ink-subtle">Plant</label>
      <Select value={plantId} onChange={setPlantId} options={options} placeholder="Select a plant…" />
      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle">Reason</label>
      <textarea
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        rows={3}
        placeholder="Why is this plant being deactivated?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="deactivate-reason"
      />
      {err && <p className="mt-2 text-sm text-critical" role="alert">{err}</p>}
    </Modal>
  );
}
