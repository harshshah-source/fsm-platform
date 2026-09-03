import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  apiCrossZoneApprove,
  apiCrossZoneDefer,
  apiCrossZoneDeny,
  apiCrossZoneList,
  apiCrossZoneSweep,
  type CrossZoneRow,
} from '../../api/crossZone';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { SLABadge, StatusPill, TierBadge } from '../../components/domain';
import { Badge, Button } from '../../components/ui';

/**
 * #354 — which side of the escalation this zone is on, as the backend's `listForScope` reports it:
 * `incoming` is work another zone's ZM raised that has been assigned to one of *our* engineers,
 * `outgoing` is work we sent out, `null` for a pan-India reader (CSM / Operations Head).
 *
 * Declared here rather than on `CrossZoneRow` because the shared API type is another slice's file
 * this round; the field is optional so a response from an older backend still renders.
 */
type CrossZoneQueueRow = CrossZoneRow & { direction?: 'incoming' | 'outgoing' | null };

/** Whole-days elapsed since an ISO timestamp (for the AgeChip-style age column). */
function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Issue 78 — Admin Cross-Zone page (`/cross-zone`, over the Issue 32 backend). Managers see the
 * cross-zone escalation queue split into Auto-Escalations (Platinum, system-swept) and Manual Flags
 * (Gold/Silver, ZM-raised). CSM / Operations Head resolve each via Approve / Deny / Defer; a ZM sees
 * their home-zone queue. Presentation-only — the backend owns all scope + business rules.
 */
export function CrossZonePage() {
  const { session } = useAuth();
  const [rows, setRows] = useState<CrossZoneQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    apiCrossZoneList()
      .then(setRows)
      .catch(() => setError('Failed to load the cross-zone escalation queue'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Cross-zone deciders (CSM / Operations Head) resolve escalations; a ZM sees the queue read-only.
  const isDecider =
    session?.role === 'CENTRAL_SERVICE_MANAGER' || session?.role === 'OPERATIONS_HEAD';

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    try {
      await fn();
      load();
    } catch {
      setError(failMsg);
    }
  };

  const approve = (id: string) => {
    const targetZone = window.prompt('Approve — target zone id:');
    if (!targetZone?.trim()) return;
    const seId = window.prompt('Approve — assign to SE (user id):');
    if (!seId?.trim()) return;
    void run(() => apiCrossZoneApprove(id, Number(targetZone.trim()), seId.trim()), 'Approve failed');
  };

  const deny = (id: string) => {
    const reason = window.prompt('Deny — reason (mandatory):');
    if (!reason?.trim()) return;
    void run(() => apiCrossZoneDeny(id, reason.trim()), 'Deny failed');
  };

  const defer = (id: string) => {
    const reviewDate = window.prompt('Defer — review date (YYYY-MM-DD):');
    if (!reviewDate?.trim()) return;
    const reason = window.prompt('Defer — reason (mandatory):');
    if (!reason?.trim()) return;
    void run(() => apiCrossZoneDefer(id, reviewDate.trim(), reason.trim()), 'Defer failed');
  };

  const sweep = () => void run(() => apiCrossZoneSweep(), 'Auto-escalation sweep failed');

  const auto = rows.filter((r) => r.escalationType === 'AUTO_PLATINUM');
  const manual = rows.filter((r) => r.escalationType === 'MANUAL_FLAG');

  const baseColumns: Column<CrossZoneQueueRow>[] = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-muted">{r.ticketId.slice(0, 8)}</span>
          {/* #354 — work assigned INTO this zone. Without it the receiving ZM's queue looked identical
              to the work they sent out, which is the read that made incoming work invisible. */}
          {r.direction === 'incoming' && (
            <Badge tone="info" data-testid={`cz-incoming-${r.escalationId}`}>
              Incoming
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-strong">{r.companyId}</span>
          <TierBadge tier={r.companyTier} />
        </span>
      ),
    },
    { key: 'bucket', header: 'Bucket', render: (r) => <SLABadge bucket={r.triggerBucket} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'age', header: 'Age', render: (r) => `${daysSince(r.createdAt)}d` },
  ];

  const actionsColumn: Column<CrossZoneQueueRow> = {
    key: 'actions',
    header: 'Actions',
    exportable: false,
    // #354 — a decided row has nothing left to decide. It can only reach this table as a target zone's
    // incoming work (the ZM read now carries APPROVED rows for the zone doing the work), and offering
    // Approve on it would send a call the backend answers with `ESCALATION_NOT_ACTIONABLE`.
    render: (r) =>
      r.status === 'APPROVED' ? (
        <span className="text-xs text-ink-muted">—</span>
      ) : (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="primary" data-testid={`cz-approve-${r.escalationId}`} onClick={() => approve(r.escalationId)}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="danger" data-testid={`cz-deny-${r.escalationId}`} onClick={() => deny(r.escalationId)}>
            Deny
          </Button>
          <Button type="button" size="sm" variant="secondary" data-testid={`cz-defer-${r.escalationId}`} onClick={() => defer(r.escalationId)}>
            Defer
          </Button>
        </div>
      ),
  };

  const columns = isDecider ? [...baseColumns, actionsColumn] : baseColumns;

  return (
    <div>
      <PageHeader
        title="Cross-Zone Escalations"
        subtitle="Platinum tickets auto-swept from an uncovered home zone, and Gold/Silver tickets a ZM manually flagged for cross-zone help. Approve, deny, or defer each."
      />

      {isDecider && (
        <div className="mb-4">
          <Button type="button" size="sm" variant="secondary" data-testid="cz-sweep" onClick={sweep}>
            Run auto-escalation sweep
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-md">
        <MetricCard label="Auto-Escalations" value={auto.length} tone="critical" />
        <MetricCard label="Manual Flags" value={manual.length} tone="warning" />
      </div>

      {(
        [
          { heading: 'Auto-Escalations (Platinum)', ariaLabel: 'Cross-Zone Auto-Escalations', rows: auto, empty: 'No auto-escalations pending.' },
          { heading: 'Manual Flags (Gold/Silver)', ariaLabel: 'Cross-Zone Manual Flags', rows: manual, empty: 'No manual flags pending.' },
        ] as const
      ).map((section) => (
        <section key={section.ariaLabel} className="mb-8 last:mb-0">
          <h3 className="mb-2 text-sm font-semibold text-ink-strong">{section.heading}</h3>
          <DataTable
            ariaLabel={section.ariaLabel}
            rowKey={(r) => r.escalationId}
            rowTestId={(r) => `cz-row-${r.escalationId}`}
            columns={columns}
            rows={section.rows}
            loading={loading}
            empty={section.empty}
          />
        </section>
      ))}
    </div>
  );
}
