import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  type PlantView,
  type ZoneView,
  listPlants,
  listZones,
} from '../../api/org';
import {
  type SeDirectoryRow,
  SeApiError,
  addSeCoverage,
  createSe,
  listSeDirectory,
  removeSeCoverage,
  setSeActive,
  updateSe,
} from '../../api/engineersAdmin';
import {
  DataTable,
  EditableCell,
  EditableSelectCell,
  FilterSelect,
  PageHeader,
  ToggleCell,
  type Column,
} from '../../components/data';
import { Badge, Button, Field, Input, SectionCard } from '../../components/ui';

/** Backend error `code` → operator-facing inline message. */
const ERROR_MESSAGE: Record<string, string> = {
  NAME_REQUIRED: 'Name is required.',
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_PHONE: 'Enter a valid phone number.',
  INVALID_DAILY_CAPACITY: 'Daily capacity must be a positive whole number.',
  INVALID_COVERAGE_TYPE: 'Choose a valid coverage type.',
  SE_IDENTITY_TAKEN: 'That phone or email is already registered to another user.',
  ZONE_FORBIDDEN: 'You can only manage Service Engineers in your own zone.',
  ZONE_NOT_FOUND: 'That zone does not exist.',
  ZONE_CHANGE_WITH_COVERAGE: 'Remove the SE’s plant coverage before moving zones.',
  SE_NOT_FOUND: 'That Service Engineer is not in your scope.',
  PLANT_NOT_FOUND: 'That plant does not exist.',
  CROSS_ZONE_COVERAGE_FORBIDDEN: 'A plant can only be mapped to an SE in the same zone.',
  FLOATING_USES_TERRITORY: 'Floating SEs use the Territory page, not plant coverage.',
  COVERAGE_EXISTS: 'That plant is already mapped to this SE.',
};
const messageFor = (code: string): string => ERROR_MESSAGE[code] ?? `Request failed (${code}).`;
const codeOf = (err: unknown): string => (err instanceof SeApiError ? err.code : 'UNKNOWN');

const COVERAGE_TYPES = ['DEDICATED', 'MULTI_PLANT'] as const;
const COVERAGE_TYPE_OPTIONS = COVERAGE_TYPES.map((c) => ({ value: c, label: c }));

const EMPTY_FORM = { name: '', phone: '', email: '', address: '', coverageType: 'DEDICATED', dailyCapacity: '10' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{5,}$/;
const requireName = (v: string): string | null => (v ? null : 'Name is required.');
const requireEmail = (v: string): string | null => (EMAIL_RE.test(v) ? null : 'Enter a valid email address.');
const requirePhone = (v: string): string | null => (PHONE_RE.test(v) ? null : 'Enter a valid phone number.');
const requireCapacity = (v: string): string | null =>
  Number.isInteger(Number(v)) && Number(v) > 0 ? null : 'Daily capacity must be a positive whole number.';

/**
 * Phase 4 — SE Management directory (`/engineers/manage`). Admin-entered Service Engineers are the source
 * of truth for dispatch: this is where OH / CSM / ZM create, edit, deactivate, and map SEs to plants over
 * the existing model. Authority is enforced server-side (this page only mirrors it for affordances): a ZM
 * is clamped to their home zone (the create Zone field is pre-filled + locked; no zone filter; the Zone
 * cell is read-only), OH / CSM pick / filter any zone and can reassign a SE's zone inline. SE→company is
 * not modelled — the column renders "—". Every editable field below is edited directly in the table cell
 * (click-to-edit for text/number, live dropdowns, and a status toggle); the side panel is reserved for
 * plant coverage, which is a many-to-many mapping and not a single cell value.
 */
export function SeManagementDirectoryPage() {
  const { session } = useAuth();
  const isZm = session?.role === 'ZONAL_MANAGER';
  const homeZoneId = session?.zone_id ?? null;

  const [rows, setRows] = useState<SeDirectoryRow[]>([]);
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [zoneFilter, setZoneFilter] = useState<string>('');
  const [form, setForm] = useState({ ...EMPTY_FORM, zoneId: isZm && homeZoneId != null ? String(homeZoneId) : '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelPlants, setPanelPlants] = useState<PlantView[]>([]);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [coverPlant, setCoverPlant] = useState('');
  const [coverType, setCoverType] = useState<string>('DEDICATED');

  const zoneName = useMemo(() => new Map(zones.map((z) => [z.zoneId, z.name])), [zones]);
  const zoneOptions = useMemo(() => zones.map((z) => ({ value: String(z.zoneId), label: z.name })), [zones]);

  const load = useCallback(() => {
    setLoading(true);
    listSeDirectory()
      .then(setRows)
      .catch(() => setError('Failed to load Service Engineers'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    void listZones().then(setZones);
  }, [load]);

  const selected = rows.find((r) => r.seId === selectedId) ?? null;

  // Load the selected SE's zone plants for the in-zone coverage picker.
  useEffect(() => {
    if (!selected) {
      setPanelPlants([]);
      return;
    }
    void listPlants(selected.zoneId).then(setPanelPlants);
    setPanelError(null);
  }, [selected?.seId, selected?.zoneId]);

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const canSubmit =
    Boolean(form.name && form.phone && form.email && form.zoneId && form.coverageType && form.dailyCapacity) &&
    !submitting;

  const submitCreate = async () => {
    setCreated(null);
    setFormError(null);
    setSubmitting(true);
    try {
      const row = await createSe({
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim() || null,
        zoneId: Number(form.zoneId),
        coverageType: form.coverageType,
        dailyCapacity: Number(form.dailyCapacity),
      });
      setCreated(row.name);
      setForm({ ...EMPTY_FORM, zoneId: isZm && homeZoneId != null ? String(homeZoneId) : '' });
      setRows((prev) => [...prev, row]);
    } catch (err) {
      setFormError(messageFor(codeOf(err)));
    } finally {
      setSubmitting(false);
    }
  };

  /** Patch a single field on one SE and splice the server's fresh row into local state — no full refetch. */
  const saveField = useCallback(async (seId: string, patch: Parameters<typeof updateSe>[1]) => {
    try {
      const updated = await updateSe(seId, patch);
      setRows((prev) => prev.map((r) => (r.seId === updated.seId ? updated : r)));
    } catch (err) {
      throw new Error(messageFor(codeOf(err)));
    }
  }, []);

  const toggleActive = useCallback(async (row: SeDirectoryRow) => {
    try {
      const updated = await setSeActive(row.seId, !row.isActive);
      setRows((prev) => prev.map((r) => (r.seId === updated.seId ? updated : r)));
    } catch (err) {
      throw new Error(messageFor(codeOf(err)));
    }
  }, []);

  const addCoverage = async () => {
    if (!selected || !coverPlant) return;
    setPanelError(null);
    try {
      await addSeCoverage(selected.seId, { plantId: Number(coverPlant), coverageType: coverType });
      setCoverPlant('');
      load();
    } catch (err) {
      setPanelError(messageFor(codeOf(err)));
    }
  };

  const dropCoverage = async (coverageId: number) => {
    if (!selected) return;
    setPanelError(null);
    try {
      await removeSeCoverage(selected.seId, coverageId);
      load();
    } catch (err) {
      setPanelError(messageFor(codeOf(err)));
    }
  };

  const columns: Column<SeDirectoryRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <EditableCell
          ariaLabel={`Edit name for ${r.name}`}
          value={r.name}
          display={<span className="font-medium text-ink-strong">{r.name}</span>}
          validate={requireName}
          onSave={(v) => saveField(r.seId, { name: v })}
        />
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      render: (r) => (
        <EditableCell
          ariaLabel={`Edit phone for ${r.name}`}
          value={r.phone}
          display={<span className="text-ink-muted">{r.phone}</span>}
          placeholder="+91 90000 00000"
          validate={requirePhone}
          onSave={(v) => saveField(r.seId, { phone: v })}
        />
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (r) => (
        <EditableCell
          ariaLabel={`Edit email for ${r.name}`}
          value={r.email}
          display={<span className="text-ink-muted">{r.email}</span>}
          type="email"
          validate={requireEmail}
          onSave={(v) => saveField(r.seId, { email: v })}
        />
      ),
    },
    {
      key: 'address',
      header: 'Address',
      render: (r) => (
        <EditableCell
          ariaLabel={`Edit address for ${r.name}`}
          value={r.address ?? ''}
          display={<span className="text-ink-muted">{r.address ?? '—'}</span>}
          onSave={(v) => saveField(r.seId, { address: v || null })}
        />
      ),
    },
    {
      key: 'zone',
      header: 'Zone',
      render: (r) =>
        isZm ? (
          <span>{zoneName.get(r.zoneId) ?? `Zone ${r.zoneId}`}</span>
        ) : (
          <EditableSelectCell
            ariaLabel={`Edit zone for ${r.name}`}
            value={String(r.zoneId)}
            options={zoneOptions}
            onSave={(v) => saveField(r.seId, { zoneId: Number(v) })}
          />
        ),
    },
    {
      key: 'coverageType',
      header: 'Coverage Type',
      render: (r) => (
        <EditableSelectCell
          ariaLabel={`Edit coverage type for ${r.name}`}
          value={r.coverageType}
          options={COVERAGE_TYPE_OPTIONS}
          onSave={(v) => saveField(r.seId, { coverageType: v })}
        />
      ),
    },
    {
      key: 'dailyCapacity',
      header: 'Daily Capacity',
      align: 'right',
      render: (r) => (
        <EditableCell
          ariaLabel={`Edit daily capacity for ${r.name}`}
          value={String(r.dailyCapacity)}
          type="number"
          validate={requireCapacity}
          onSave={(v) => saveField(r.seId, { dailyCapacity: Number(v) })}
        />
      ),
    },
    {
      key: 'plants',
      header: 'Mapped Plants',
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <span>{r.plants.length ? r.plants.map((p) => p.name).join(', ') : '—'}</span>
          <button
            type="button"
            onClick={() => setSelectedId(r.seId)}
            className="text-xs text-brand-700 hover:underline"
          >
            Manage coverage →
          </button>
        </div>
      ),
    },
    { key: 'companies', header: 'Mapped Companies', render: () => <span className="text-ink-muted">—</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex items-center gap-2">
          <ToggleCell
            ariaLabel={`${r.isActive ? 'Deactivate' : 'Reactivate'} ${r.name}`}
            active={r.isActive}
            onToggle={() => toggleActive(r)}
          />
          <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
    },
  ];

  const visibleRows = zoneFilter ? rows.filter((r) => String(r.zoneId) === zoneFilter) : rows;

  return (
    <div>
      <PageHeader
        title="SE Management"
        subtitle="Create and maintain Service Engineers and their plant coverage. The Recommender dispatches to whatever SEs are entered here — an empty zone simply means no candidate. Click any cell to edit it directly."
        actions={
          !isZm ? (
            <Field label="Filter zone" htmlFor="se-zone-filter">
              <FilterSelect id="se-zone-filter" value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}>
                <option value="">All zones</option>
                {zones.map((z) => (
                  <option key={z.zoneId} value={z.zoneId}>
                    {z.name}
                  </option>
                ))}
              </FilterSelect>
            </Field>
          ) : undefined
        }
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-6 max-w-3xl">
        <SectionCard title="Add Service Engineer">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="se-name">
              <Input id="se-name" value={form.name} onChange={(e) => set('name')(e.target.value)} />
            </Field>
            <Field label="Phone" htmlFor="se-phone">
              <Input id="se-phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} placeholder="+91 90000 00000" />
            </Field>
            <Field label="Email" htmlFor="se-email">
              <Input id="se-email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />
            </Field>
            <Field label="Address" htmlFor="se-address">
              <Input id="se-address" value={form.address} onChange={(e) => set('address')(e.target.value)} />
            </Field>
            <Field label="Zone" htmlFor="se-zone">
              {isZm ? (
                <Input id="se-zone" value={zoneName.get(homeZoneId ?? -1) ?? (homeZoneId != null ? `Zone ${homeZoneId}` : '')} disabled readOnly />
              ) : (
                <FilterSelect id="se-zone" className="w-full" value={form.zoneId} onChange={(e) => set('zoneId')(e.target.value)}>
                  <option value="">Select a zone…</option>
                  {zones.map((z) => (
                    <option key={z.zoneId} value={z.zoneId}>
                      {z.name}
                    </option>
                  ))}
                </FilterSelect>
              )}
            </Field>
            <Field label="Coverage Type" htmlFor="se-coverage-type">
              <FilterSelect id="se-coverage-type" className="w-full" value={form.coverageType} onChange={(e) => set('coverageType')(e.target.value)}>
                {COVERAGE_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </FilterSelect>
            </Field>
            <Field label="Daily Capacity" htmlFor="se-capacity">
              <Input id="se-capacity" type="number" min={1} value={form.dailyCapacity} onChange={(e) => set('dailyCapacity')(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3">
            <Button type="button" onClick={() => void submitCreate()} disabled={!canSubmit} loading={submitting}>
              Add Service Engineer
            </Button>
          </div>
          {created && (
            <p role="status" className="mt-2 text-sm text-success">
              Added <strong>{created}</strong>.
            </p>
          )}
          {formError && (
            <p role="alert" className="mt-2 text-sm text-critical">
              {formError}
            </p>
          )}
        </SectionCard>
      </div>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <DataTable
            ariaLabel="SE Directory"
            rowKey={(r) => r.seId}
            rowTestId={(r) => `se-dir-${r.seId}`}
            columns={columns}
            rows={visibleRows}
            loading={loading}
            empty="No SEs yet — add engineers to enable dispatch."
          />
        </div>

        {selected && (
          <section aria-label="SE coverage" className="w-80 shrink-0 rounded-card border border-line bg-surface-card p-4 text-sm shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-ink-strong">{selected.name}</h3>
                <p className="text-xs text-ink-muted">
                  {selected.coverageType} · {selected.isActive ? 'Active' : 'Inactive'}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setSelectedId(null)}
                className="text-ink-muted hover:text-ink-strong"
              >
                ✕
              </button>
            </div>

            <div className="border-t border-line pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">Coverage</div>
              {selected.plants.length === 0 && <div className="text-ink-muted">No mapped plants</div>}
              <ul className="text-ink">
                {selected.plants.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span>{p.name}</span>
                    {p.coverageId != null && (
                      <button
                        type="button"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => void dropCoverage(p.coverageId!)}
                        className="text-xs text-critical hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-col gap-2">
                <FilterSelect aria-label="Add coverage plant" className="w-full" value={coverPlant} onChange={(e) => setCoverPlant(e.target.value)}>
                  <option value="">Select a plant…</option>
                  {panelPlants.map((p) => (
                    <option key={p.plantId} value={p.plantId}>
                      {p.name}
                    </option>
                  ))}
                </FilterSelect>
                <FilterSelect aria-label="Coverage type" className="w-full" value={coverType} onChange={(e) => setCoverType(e.target.value)}>
                  {COVERAGE_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </FilterSelect>
                <Button size="sm" onClick={() => void addCoverage()} disabled={!coverPlant} className="self-start">
                  Add coverage
                </Button>
              </div>
            </div>

            {panelError && (
              <p role="alert" className="mt-2 text-sm text-critical">
                {panelError}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
