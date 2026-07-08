import { useEffect, useMemo, useState } from 'react';
import {
  type CompanyView,
  type PlantView,
  listCompanies,
  listPlants,
} from '../../api/org';
import {
  type CreateInstallBody,
  type CsvRowError,
  InstallApiError,
  createInstall,
  uploadInstallCsv,
} from '../../api/install';
import { useAuth } from '../../auth/AuthProvider';
import {
  DataTable,
  FilterSelect,
  PageHeader,
  type Column,
} from '../../components/data';
import { Button, Field, Input, SectionCard } from '../../components/ui';

/** Backend error `code` → operator-facing inline message (single-create + CSV structural codes). */
const ERROR_MESSAGE: Record<string, string> = {
  VEHICLE_NOT_FOUND: 'Vehicle not found.',
  DEVICE_NOT_FOUND: 'Device not found.',
  PLANT_NOT_FOUND: 'Plant not found.',
  COMPANY_NOT_FOUND: 'Company not found.',
  VEHICLE_ALREADY_MAPPED: 'This vehicle already has an active device.',
  DEVICE_ALREADY_MAPPED: 'This device is already active on a vehicle.',
  ZONE_FORBIDDEN: 'This plant is outside your zone authority.',
  MISSING_REQUIRED_FIELD: 'Please fill in all required fields.',
  INVALID_ID: 'Plant, Company and Device must be numeric ids.',
  INVALID_TARGET_DATE: 'The target date is invalid.',
  CSV_REQUIRED: 'Paste CSV content before uploading.',
  CSV_VALIDATION_FAILED: 'The CSV has row errors — fix them and re-upload.',
};

const messageFor = (code: string): string => ERROR_MESSAGE[code] ?? `Request failed (${code}).`;

const EMPTY_FORM = {
  vehicleNo: '',
  plantId: '',
  companyId: '',
  deviceType: '',
  deviceId: '',
  simId: '',
  targetDate: '',
  notes: '',
};

/**
 * Issue 69 — Admin Install-create UI. The manual Install-Ticket creation surface over the Issue 33
 * backend (`POST /api/install`, `POST /api/install/upload`): a single-create form and a CSV bulk
 * upload, gated to the creator roles by the route (`RoleRoute` ZM/CSM/OH) and scoped server-side.
 * Presentation only — no business logic lives here; row-error codes map to inline messages.
 */
export function InstallCreatePage() {
  const { session } = useAuth();
  // Zone scope for the plant picker: a ZM only creates in their own zone; CSM / Operations Head
  // pick from every zone (the backend enforces the same scope from the JWT).
  const zoneScope =
    session?.role === 'ZONAL_MANAGER' && session.zone_id != null ? session.zone_id : undefined;

  const [plants, setPlants] = useState<PlantView[]>([]);
  const [companies, setCompanies] = useState<CompanyView[]>([]);

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [created, setCreated] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [csv, setCsv] = useState('');
  const [batch, setBatch] = useState<{ batchId: string; count: number } | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<CsvRowError[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void listPlants(zoneScope).then(setPlants);
    void listCompanies().then(setCompanies);
  }, [zoneScope]);

  const set = (key: keyof typeof EMPTY_FORM) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const canSubmit =
    Boolean(form.vehicleNo && form.plantId && form.companyId && form.deviceType && form.deviceId) && !submitting;

  const submitSingle = async () => {
    setCreated(null);
    setFormError(null);
    setSubmitting(true);
    try {
      const body: CreateInstallBody = {
        vehicleNo: form.vehicleNo.trim(),
        plantId: form.plantId,
        companyId: form.companyId,
        deviceType: form.deviceType.trim(),
        deviceId: form.deviceId.trim(),
        ...(form.simId.trim() ? { simId: form.simId.trim() } : {}),
        ...(form.targetDate ? { targetDate: form.targetDate } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      };
      const ticket = await createInstall(body);
      setCreated(ticket.ticketId);
      setForm({ ...EMPTY_FORM });
    } catch (err) {
      setFormError(messageFor(err instanceof InstallApiError ? err.code : 'UNKNOWN'));
    } finally {
      setSubmitting(false);
    }
  };

  const submitCsv = async () => {
    setBatch(null);
    setCsvError(null);
    setRowErrors([]);
    setUploading(true);
    try {
      const result = await uploadInstallCsv(csv);
      setBatch({ batchId: result.batchId, count: result.created.length });
      setCsv('');
    } catch (err) {
      if (err instanceof InstallApiError) {
        setCsvError(messageFor(err.code));
        setRowErrors(err.errors ?? []);
      } else {
        setCsvError(messageFor('UNKNOWN'));
      }
    } finally {
      setUploading(false);
    }
  };

  const errorColumns: Column<CsvRowError>[] = useMemo(
    () => [
      { key: 'line', header: 'Line', render: (r) => `Line ${r.line}` },
      { key: 'code', header: 'Error', render: (r) => r.code },
      { key: 'field', header: 'Field', render: (r) => r.field ?? '—' },
    ],
    [],
  );

  return (
    <section>
      <PageHeader
        title="Install Tickets"
        subtitle="Create Install Tickets one at a time, or bulk-upload a CSV. Scoped to your zone authority."
      />

      <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
        <SectionCard title="Single Install">
          <div className="flex flex-col gap-3">
            <Field label="Vehicle No" htmlFor="install-vehicle-no">
              <Input
                id="install-vehicle-no"
                value={form.vehicleNo}
                onChange={(e) => set('vehicleNo')(e.target.value)}
                placeholder="e.g. MH12AB1234"
              />
            </Field>

            <Field label="Plant" htmlFor="install-plant">
              <FilterSelect
                id="install-plant"
                className="w-full"
                value={form.plantId}
                onChange={(e) => set('plantId')(e.target.value)}
              >
                <option value="">Select a plant…</option>
                {plants.map((p) => (
                  <option key={p.plantId} value={p.plantId}>
                    {p.name}
                  </option>
                ))}
              </FilterSelect>
            </Field>

            <Field label="Company" htmlFor="install-company">
              <FilterSelect
                id="install-company"
                className="w-full"
                value={form.companyId}
                onChange={(e) => set('companyId')(e.target.value)}
              >
                <option value="">Select a company…</option>
                {companies.map((c) => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.name}
                  </option>
                ))}
              </FilterSelect>
            </Field>

            <Field label="Device Type" htmlFor="install-device-type">
              <Input
                id="install-device-type"
                value={form.deviceType}
                onChange={(e) => set('deviceType')(e.target.value)}
                placeholder="e.g. GT06N"
              />
            </Field>

            <Field label="Device ID" htmlFor="install-device-id">
              <Input
                id="install-device-id"
                value={form.deviceId}
                onChange={(e) => set('deviceId')(e.target.value)}
                placeholder="numeric device id"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="SIM ID (optional)" htmlFor="install-sim-id">
                <Input id="install-sim-id" value={form.simId} onChange={(e) => set('simId')(e.target.value)} />
              </Field>
              <Field label="Target Date (optional)" htmlFor="install-target-date">
                <Input
                  id="install-target-date"
                  type="date"
                  value={form.targetDate}
                  onChange={(e) => set('targetDate')(e.target.value)}
                />
              </Field>
            </div>

            <Field label="Notes (optional)" htmlFor="install-notes">
              <Input id="install-notes" value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
            </Field>

            <div className="mt-1">
              <Button type="button" onClick={() => void submitSingle()} disabled={!canSubmit} loading={submitting}>
                Create Install
              </Button>
            </div>

            {created && (
              <p role="status" className="text-sm text-success">
                Created install ticket <strong>{created}</strong>.
              </p>
            )}
            {formError && (
              <p role="alert" className="text-sm text-critical">
                {formError}
              </p>
            )}
          </div>
        </SectionCard>

        <SectionCard title="CSV bulk upload">
          <div className="flex flex-col gap-3">
            <Field
              label="CSV (header: vehicle_no, plant_id, company_id, device_type, device_id; optional sim_id, target_date, notes)"
              htmlFor="install-csv"
            >
              <textarea
                id="install-csv"
                className="min-h-[8rem] w-full rounded-md border border-line bg-surface-card px-3 py-2 font-mono text-xs text-ink-strong"
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={'vehicle_no,plant_id,company_id,device_type,device_id\nMH12AB1234,5,9,GT06N,1001'}
              />
            </Field>

            <div>
              <Button type="button" onClick={() => void submitCsv()} disabled={!csv.trim() || uploading} loading={uploading}>
                Upload CSV
              </Button>
            </div>

            {batch && (
              <div role="status" className="text-sm text-success">
                <p>
                  Created <strong>{batch.count}</strong> install ticket{batch.count === 1 ? '' : 's'}.
                </p>
                <p>Batch {batch.batchId}</p>
              </div>
            )}
            {csvError && (
              <p role="alert" className="text-sm text-critical">
                {csvError}
              </p>
            )}
            {rowErrors.length > 0 && (
              <DataTable
                columns={errorColumns}
                rows={rowErrors}
                rowKey={(r) => `${r.line}-${r.code}`}
                ariaLabel="CSV errors"
              />
            )}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
