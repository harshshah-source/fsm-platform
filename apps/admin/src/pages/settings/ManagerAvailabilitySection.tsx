import { useCallback, useEffect, useState } from 'react';
import { listZones, type ZoneView } from '../../api/org';
import {
  endUnavailability,
  listUnavailability,
  openUnavailability,
  type UnavailabilityRow,
} from '../../api/roleUnavailability';
import { Button, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import { EntryForm, Field, Notice, TablePanel, SettingsSection, cellClass, rowClass } from './primitives';

/**
 * Manager availability (#339 AC4) — who is covering a zone, and until when.
 *
 * **Why this screen had to exist before the acting gate could.** `POST /role-unavailability` shipped
 * with Issue 27 and no screen ever called it; nothing could read a window back and nothing could end
 * one. The cascade in `RoleBackupService` was therefore reading a table only a database client could
 * write. #339 makes a CSM's acting request depend on exactly that table, which turns "no UI" from an
 * omission into a blocker: the rule *"a CSM may act only while that zone's ZM is out"* is unusable if
 * no operator can say a ZM is out, see that they are, or say that they are back.
 *
 * **A window is ended, never deleted** — the server stamps `window_end`. The row is the record of who
 * was covering a zone while decisions were being made in it, and the CSM-backup share report (Issue 27
 * AC#5) reads that history to tell an Operations Head when ZM backup has quietly become routine.
 *
 * Presentation is the console's own vocabulary (`SettingsSection` + `TablePanel` + an entry band),
 * because reference 26 draws no card for this and inventing a second visual language for one table
 * would be the larger deviation.
 */
export function ManagerAvailabilitySection() {
  const [rows, setRows] = useState<UnavailabilityRow[]>([]);
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRows(await listUnavailability());
      setError(null);
    } catch {
      setError('Failed to load manager availability.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    listZones()
      .then(setZones)
      .catch(() => undefined);
  }, [reload]);

  const submit = async (e: { preventDefault: () => void }): Promise<void> => {
    e.preventDefault();
    const zone = Number(zoneId);
    if (!Number.isInteger(zone) || zone <= 0) return;
    setBusy(true);
    try {
      // Open-ended and starting now: the operator pressed this because the manager is out *today*,
      // and a window with a start in the future authorises nothing at the moment it is needed. It is
      // ended from this table when they are back — which is the same act, recorded, as a return date
      // nobody would have kept up to date.
      await openUnavailability({
        role: 'ZONAL_MANAGER',
        zoneId: zone,
        windowStart: new Date().toISOString(),
        windowEnd: null,
        reason: reason.trim() || null,
      });
      setZoneId('');
      setReason('');
      await reload();
    } catch {
      setError('Could not mark that manager unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const end = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await endUnavailability(id);
      await reload();
    } catch {
      setError('Could not end that window.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Manager availability"
      description="While a zone's Zonal Manager is marked unavailable, their duty cascades to the Central Service Manager — and only then may a CSM act in that zone. Ending a window hands the zone straight back."
    >
      {error && <Notice tone="critical">{error}</Notice>}

      <TablePanel
        ariaLabel="Manager availability"
        headers={[
          { label: 'Role' },
          { label: 'Zone' },
          { label: 'From' },
          { label: 'Until' },
          { label: 'Reason' },
          { label: 'Status' },
          { label: '' },
        ]}
        rowCount={rows.length}
        loading={loading}
        emptyMessage="No manager is marked unavailable."
        emptyHint="Mark one above when a Zonal Manager is out — a CSM cannot act in their zone until you do."
        toolbar={
          <EntryForm
            legend="Mark a manager unavailable"
            onSubmit={submit}
            action={
              <Button className="w-full sm:w-auto" type="submit" disabled={busy || !zoneId}>
                Mark manager unavailable
              </Button>
            }
          >
            <Field label="Zone">
              <Select aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                <option value="">Select zone…</option>
                {zones.map((z) => (
                  <option key={z.zoneId} value={String(z.zoneId)}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {rows.map((r) => (
          <tr key={r.id} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{roleLabel(r.role)}</td>
            {/* The name, not the id: an operator picked "West" and cannot check a `3`. */}
            <td className={cellClass}>{r.zoneName ?? (r.zoneId ? `Zone ${r.zoneId}` : 'All zones')}</td>
            <td className={cellClass}>{formatWhen(r.windowStart)}</td>
            <td className={cellClass}>{r.windowEnd ? formatWhen(r.windowEnd) : '—'}</td>
            <td className={cellClass}>{r.reason ?? '—'}</td>
            <td className={cellClass}>
              <span className={cn('text-xs font-semibold', r.open ? 'text-warning' : 'text-ink-muted')}>
                {r.open ? 'In force' : 'Ended'}
              </span>
            </td>
            <td className={cn(cellClass, 'text-right')}>
              {r.open && (
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void end(r.id)}>
                  End
                </Button>
              )}
            </td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

const ROLE_LABELS: Record<string, string> = {
  ZONAL_MANAGER: 'Zonal Manager',
  CENTRAL_SERVICE_MANAGER: 'Central Service Manager',
  OPERATIONS_HEAD: 'Operations Head',
  WAREHOUSE_MANAGER: 'Warehouse Manager',
  SERVICE_ENGINEER: 'Service Engineer',
};

const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

/** Short, local, and unambiguous — an operator reads these beside "In force", not in isolation. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
