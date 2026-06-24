import { useCallback, useEffect, useState } from 'react';
import { apiCsmApprovalShare, type CsmBackupZoneRow } from '../../api/roleBackup';

/**
 * CSM Backup Share report (Issue 27, AC#5, Operations Head). Per-zone share of acted-as-backup
 * actions performed by a Central Service Manager this month, so Operations Head can spot zones where
 * ZM backup is becoming routine. Attribution via `audit_logs.acting_zone` (stamped on acted-as flows).
 */
export function CsmApprovalSharePage() {
  const [rows, setRows] = useState<CsmBackupZoneRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiCsmApprovalShare()
      .then(setRows)
      .catch(() => setError('Failed to load the CSM backup report'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">CSM Backup Share</h2>
      <p className="mb-4 text-sm text-slate-500">
        Share of acted-as-backup actions performed by a Central Service Manager this month, by zone.
        Rising shares flag zones where Zonal-Manager backup is becoming routine.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <table aria-label="CSM Backup Share" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Zone</th>
            <th className="py-2 pr-3">CSM-acted actions</th>
            <th className="py-2 pr-3">Total acted actions</th>
            <th className="py-2 pr-3">CSM share</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-slate-400">
                No acted-as-backup activity this month.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.zoneId} data-testid={`csm-row-${r.zoneId}`} className="border-b hover:bg-slate-50">
              <td className="py-2 pr-3">Zone {r.zoneId}</td>
              <td className="py-2 pr-3">{r.csmActions}</td>
              <td className="py-2 pr-3">{r.totalActedActions}</td>
              <td className="py-2 pr-3 font-medium">{r.sharePct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
