import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelTierOverride,
  createTierOverride,
  listTierOverrides,
  type TierOverrideRow,
} from '../../api/tierOverrides';
import { listCompanies, listTiers, listZones, type CompanyView, type TierView, type ZoneView } from '../../api/org';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { Modal } from '../../components/overlay';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

/** Q-B (operator decision): the scope this knob does and does NOT have — stated wherever it is turned. */
const SCOPE_COPY =
  'A tier override affects dispatch ordering and newly-created tickets. Existing tickets keep the tier they were created with — including for Platinum cross-zone auto-escalation.';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/**
 * Tier Overrides (#157 S5). The CSM/ZM authority extension over the OH-owned global company tier (#46):
 * a zone-scoped, expiring override with a mandatory reason. This is a role-variant page (ZM own-zone;
 * CSM/OH any zone) rather than a Settings section, because Settings is OH-only in the v2 reference yet
 * this feature is explicitly for CSM/ZM — a documented parity discrepancy, mirroring the #158 Plant
 * Zones precedent (no reference surface existed either). The list doubles as the monthly active-overrides
 * report; the live winning override per (company, zone) pair is badged (AC-6).
 */
export function TierOverridesPage() {
  const { session } = useAuth();
  const isZm = session?.role === 'ZONAL_MANAGER';
  const homeZoneId = session?.zone_id ?? null;

  const [rows, setRows] = useState<TierOverrideRow[]>([]);
  const [companies, setCompanies] = useState<CompanyView[]>([]);
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [tiers, setTiers] = useState<TierView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<TierOverrideRow | null>(null);

  const load = useCallback(() => {
    Promise.all([listTierOverrides({ status: 'ACTIVE' }), listCompanies(), listZones(), listTiers()])
      .then(([o, c, z, t]) => {
        setRows(o);
        setCompanies(c);
        setZones(z);
        setTiers(t);
      })
      .catch(() => setError('Failed to load tier overrides'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const afterWrite = () => {
    setShowCreate(false);
    setCancelTarget(null);
    load();
  };

  const homeZone = useMemo(() => zones.find((z) => z.zoneId === homeZoneId) ?? null, [zones, homeZoneId]);

  const columns: Column<TierOverrideRow>[] = [
    { key: 'company', header: 'Company', render: (r) => r.companyName || `#${r.companyId}` },
    { key: 'zone', header: 'Zone', render: (r) => r.zoneName ?? `#${r.zoneId}` },
    {
      key: 'tier',
      header: 'Override tier',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span>{r.tier}</span>
          {r.isWinning && (
            <Badge tone="brand" data-testid={`winning-${r.id}`}>
              Winning
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-ink-muted">{r.reason}</span> },
    { key: 'expiresAt', header: 'Expires', render: (r) => fmtDate(r.expiresAt) },
    { key: 'createdBy', header: 'Created by', render: (r) => r.createdBy ?? '—' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        r.status === 'ACTIVE' ? (
          <span className="flex justify-end">
            <Button variant="secondary" size="sm" data-testid={`cancel-${r.id}`} onClick={() => setCancelTarget(r)}>
              Cancel
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <section>
      <PageHeader
        title="Tier Overrides"
        subtitle="Raise or lower a company's priority tier for a single zone, for a limited time. The override auto-reverts to the company's global tier when it expires."
        actions={
          <Button data-testid="open-create" onClick={() => setShowCreate(true)}>
            New override
          </Button>
        }
      />

      <p data-testid="scope-note" className="mb-4 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink-muted">
        {SCOPE_COPY}
      </p>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowTestId={(r) => `tier-override-row-${r.id}`}
        ariaLabel="Tier overrides"
        empty={<EmptyState message="No active tier overrides." />}
      />

      {showCreate && (
        <CreateOverrideDialog
          companies={companies}
          zones={zones}
          tiers={tiers}
          isZm={isZm}
          homeZoneId={homeZoneId}
          homeZoneName={homeZone?.name ?? null}
          onClose={() => setShowCreate(false)}
          onDone={afterWrite}
        />
      )}

      {cancelTarget && (
        <CancelOverrideDialog override={cancelTarget} onClose={() => setCancelTarget(null)} onDone={afterWrite} />
      )}
    </section>
  );
}

function CreateOverrideDialog({
  companies,
  zones,
  tiers,
  isZm,
  homeZoneId,
  homeZoneName,
  onClose,
  onDone,
}: {
  companies: CompanyView[];
  zones: ZoneView[];
  tiers: TierView[];
  isZm: boolean;
  homeZoneId: number | null;
  homeZoneName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [companyId, setCompanyId] = useState('');
  // A ZM is clamped to their home zone (backend enforces; the UI reflects it by locking the field).
  const [zoneId, setZoneId] = useState<string>(isZm && homeZoneId != null ? String(homeZoneId) : '');
  const [tier, setTier] = useState('');
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!companyId) return setErr('Pick a company.');
    if (!zoneId) return setErr('Pick a zone.');
    if (!tier) return setErr('Pick a tier.');
    if (reason.trim().length < 10) return setErr('A reason of at least 10 characters is required.');
    if (!expiry) return setErr('Pick an expiry date.');
    setBusy(true);
    setErr(null);
    try {
      await createTierOverride({
        companyId: Number(companyId),
        zoneId: Number(zoneId),
        tier,
        reason: reason.trim(),
        expiresAt: new Date(expiry).toISOString(),
      });
      onDone();
    } catch {
      setErr('Creating the override failed — check the expiry is within 2 months and try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New tier override"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="confirm-create" loading={busy} onClick={submit}>
            Create override
          </Button>
        </div>
      }
    >
      <p data-testid="scope-note" className="mb-3 text-sm text-ink-muted">
        {SCOPE_COPY}
      </p>

      <label className="mb-1 block text-xs font-medium text-ink-subtle" htmlFor="tov-company">
        Company
      </label>
      <select
        id="tov-company"
        data-testid="company-select"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        value={companyId}
        onChange={(e) => setCompanyId(e.target.value)}
      >
        <option value="">Select a company…</option>
        {companies.map((c) => (
          <option key={c.companyId} value={String(c.companyId)}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle" htmlFor="tov-zone">
        Zone
      </label>
      {isZm ? (
        <input
          id="tov-zone"
          data-testid="zone-locked"
          readOnly
          className="w-full rounded-md border border-line bg-surface-sunken p-2 text-sm text-ink-muted"
          value={homeZoneName ?? (homeZoneId != null ? `#${homeZoneId}` : 'Your zone')}
        />
      ) : (
        <select
          id="tov-zone"
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
      )}

      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle" htmlFor="tov-tier">
        Override tier
      </label>
      <select
        id="tov-tier"
        data-testid="tier-select"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        value={tier}
        onChange={(e) => setTier(e.target.value)}
      >
        <option value="">Select a tier…</option>
        {tiers.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>

      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle" htmlFor="tov-reason">
        Reason
      </label>
      <textarea
        id="tov-reason"
        data-testid="reason-input"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        rows={3}
        placeholder="Why is this company's tier changing for this zone?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <label className="mb-1 mt-3 block text-xs font-medium text-ink-subtle" htmlFor="tov-expiry">
        Expires (within 2 months)
      </label>
      <input
        id="tov-expiry"
        data-testid="expiry-input"
        type="date"
        className="w-full rounded-md border border-line bg-surface-raised p-2 text-sm"
        value={expiry}
        onChange={(e) => setExpiry(e.target.value)}
      />

      {err && (
        <p className="mt-2 text-sm text-critical" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}

function CancelOverrideDialog({
  override,
  onClose,
  onDone,
}: {
  override: TierOverrideRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cancelTierOverride(override.id);
      onDone();
    } catch {
      setErr('Cancelling the override failed — please try again.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel the ${override.tier} override for ${override.companyName || `#${override.companyId}`}?`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button data-testid="confirm-cancel" loading={busy} onClick={confirm}>
            Cancel override
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-muted">
        The company reverts to its {override.zoneName ?? `zone #${override.zoneId}`} effective tier immediately. Existing
        tickets keep the tier they were created with.
      </p>
      {err && (
        <p className="mt-2 text-sm text-critical" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}
