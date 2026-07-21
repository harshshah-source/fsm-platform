import { useEffect, useMemo, useState } from 'react';
import { apiOperatingMode, type ZoneOperatingMode } from '../../api/operatingMode';
import { useAuth } from '../../auth/AuthProvider';
import { operatingModeCopy, type OperatingModeTone } from '../../utils/operatingModeCopy';
import { Badge, SectionCard, type BadgeTone } from '../ui';

/**
 * Cross-zone operating-mode TABLE (Issue 136 slice 3) — the OH/CSM legibility surface: every zone's
 * current recommender mode, sortable, so an operator can order worst-first for triage. Read-only; ZMs
 * see their own-zone card instead.
 *
 * A sortable table (not a chip strip): the dashboard band is ~200px tall, so a strip fits ~5 zones and
 * wraps/overflows beyond that — a table row-per-zone reads cleanly at 5 zones today and scales past 5
 * (growth headroom), and a sortable header lets an OH pull the zones needing attention to the top.
 * All copy comes from `operatingModeCopy` (third-person voice); the raw enum is never rendered.
 *
 * NOTE (deferred wiring): mounting on the OH/CSM dashboard body touches `OpsHeadDashboard`/`ManagerDashboard`,
 * mid-flight in a concurrent session; the ~1-line placement lands once those files are free.
 */
const TONE_TO_BADGE: Record<OperatingModeTone, BadgeTone> = {
  attention: 'warning',
  calm: 'success',
};

type SortKey = 'zone' | 'status' | 'quiet';
type SortDir = 'asc' | 'desc';

// Attention (Catch-up) sorts ahead of calm (Steady) in ascending order — triage-first default.
const MODE_RANK: Record<ZoneOperatingMode['mode'], number> = { DEFICIT: 0, PREVENTIVE: 1 };
const DEFAULT_DIR: Record<SortKey, SortDir> = { zone: 'asc', status: 'asc', quiet: 'desc' };

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'zone', label: 'Zone' },
  { key: 'status', label: 'Status' },
  { key: 'quiet', label: 'Devices quiet' },
];

function compare(a: ZoneOperatingMode, b: ZoneOperatingMode, key: SortKey): number {
  if (key === 'zone') return a.zoneName.localeCompare(b.zoneName);
  if (key === 'status') return MODE_RANK[a.mode] - MODE_RANK[b.mode];
  return a.silentCount - b.silentCount;
}

export function ZoneOperatingModeTable() {
  const { session } = useAuth();
  const canSee = session?.role === 'OPERATIONS_HEAD' || session?.role === 'CENTRAL_SERVICE_MANAGER';
  const [rows, setRows] = useState<ZoneOperatingMode[] | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'status', dir: 'asc' });

  useEffect(() => {
    if (!canSee) return;
    apiOperatingMode()
      .then(setRows)
      .catch(() => setRows([])); // stay quiet on a transient error rather than crashing the dashboard
  }, [canSee]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const factor = sort.dir === 'asc' ? 1 : -1;
    // Stable tiebreak on zone name keeps ordering deterministic across re-sorts.
    return [...rows].sort((a, b) => compare(a, b, sort.key) * factor || a.zoneName.localeCompare(b.zoneName));
  }, [rows, sort]);

  if (!canSee || rows === null) return null;

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }));

  return (
    <div data-testid="zone-operating-mode-table">
      <SectionCard title="Zones — operating mode">
        {sorted.length === 0 ? (
          <p className="text-sm text-ink-muted">No zones to show yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="text-left"
                  >
                    <button
                      type="button"
                      aria-label={`Sort by ${col.label.toLowerCase()}`}
                      onClick={() => toggle(col.key)}
                      className="inline-flex items-center gap-1"
                    >
                      {col.label}
                      <span aria-hidden className="text-[0.7em] opacity-70">
                        {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const copy = operatingModeCopy(row, 'other');
                return (
                  <tr key={row.zoneId} data-testid={`zone-mode-row-${row.zoneId}`}>
                    <td className="font-medium text-ink-strong">{row.zoneName}</td>
                    <td>
                      <Badge tone={TONE_TO_BADGE[copy.tone]}>{copy.label}</Badge>
                    </td>
                    <td className="text-ink-muted">{copy.primaryFact}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
