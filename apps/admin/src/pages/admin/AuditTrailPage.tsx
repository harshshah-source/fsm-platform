import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import {
  apiAuditSearch,
  format,
  metadataChanges,
  metadataDetail,
  metadataReason,
  type AuditLedgerRow,
  type AuditSearchFilters,
} from '../../api/auditTrail';
import { listZones, type ZoneView } from '../../api/org';
import { DataTable, FilterSelect, PageHeader, SearchInput, type Column } from '../../components/data';
import { Badge, Button, SectionCard } from '../../components/ui';

/** The filter state the form holds — all strings, because they come from inputs and the URL. */
interface Draft {
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string;
  actedAsRole: string;
  zoneId: string;
  from: string;
  to: string;
}

const EMPTY: Draft = { action: '', entityType: '', entityId: '', actorUserId: '', actedAsRole: '', zoneId: '', from: '', to: '' };

const PAGE_SIZE = 50;

/** A local `YYYY-MM-DD` from a date input, widened to the whole day in the caller's timezone. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

function toFilters(draft: Draft): AuditSearchFilters {
  return {
    action: draft.action.trim() || undefined,
    entityType: draft.entityType.trim() || undefined,
    entityId: draft.entityId.trim() || undefined,
    actorUserId: draft.actorUserId.trim() || undefined,
    actedAsRole: draft.actedAsRole || undefined,
    zoneId: draft.zoneId ? Number(draft.zoneId) : undefined,
    from: dayStart(draft.from),
    to: dayEnd(draft.to),
  };
}

/**
 * #342 — the Audit Trail ledger. The first screen in the product that can answer "who did what, in
 * whose scope, when" without already knowing a ticket UUID; before it, every `audit_logs` row was
 * reachable only through `/audit-trail/tickets/:id` or the OH-only, flag-gated Data Explorer.
 *
 * No v2 reference image exists for a ledger page, so this follows the Ops Explorer's table chrome
 * (query card above a `DataTable`) rather than inventing a third table idiom — recorded as an
 * approved-design gap on the issue.
 *
 * The zone clamp is **not** re-implemented here. A ZM's request comes back already clamped, and the
 * zone filter is only offered to the two pan-India roles, so the screen never suggests a reach the
 * server would refuse. `Zone` still renders on every row: for a ZM it is the constant proof of the
 * clamp, and for a CSM it is the column the whole page is for.
 */
export function AuditTrailPage() {
  const { session } = useAuth();
  const panIndia = session?.role === 'CENTRAL_SERVICE_MANAGER' || session?.role === 'OPERATIONS_HEAD';
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep links land here from other screens (`/audit-trail?entityType=ticket&entityId=…`).
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY,
    action: searchParams.get('action') ?? '',
    entityType: searchParams.get('entityType') ?? '',
    entityId: searchParams.get('entityId') ?? '',
    actorUserId: searchParams.get('actorUserId') ?? '',
  }));
  const [applied, setApplied] = useState<AuditSearchFilters>(() => toFilters({
    ...EMPTY,
    action: searchParams.get('action') ?? '',
    entityType: searchParams.get('entityType') ?? '',
    entityId: searchParams.get('entityId') ?? '',
    actorUserId: searchParams.get('actorUserId') ?? '',
  }));

  const [rows, setRows] = useState<AuditLedgerRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zones, setZones] = useState<ZoneView[]>([]);

  useEffect(() => {
    if (!panIndia) return;
    let alive = true;
    listZones()
      .then((z) => alive && setZones(z))
      .catch(() => undefined); // the zone filter is a convenience; its absence must not blank the page
    return () => {
      alive = false;
    };
  }, [panIndia]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiAuditSearch({ ...applied, limit: PAGE_SIZE })
      .then((page) => {
        setRows(page.rows);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setError('Failed to load the audit ledger'))
      .finally(() => setLoading(false));
  }, [applied]);

  useEffect(load, [load]);

  const loadMore = () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    apiAuditSearch({ ...applied, limit: PAGE_SIZE, cursor: nextCursor })
      .then((page) => {
        // Append: the cursor is keyset, so a page can never repeat a row already on screen.
        setRows((current) => [...current, ...page.rows]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setError('Failed to load more rows'))
      .finally(() => setLoadingMore(false));
  };

  const apply = () => {
    setApplied(toFilters(draft));
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value) next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  const clear = () => {
    setDraft(EMPTY);
    setApplied({});
    setSearchParams(new URLSearchParams(), { replace: true });
  };
  /** Row affordance: pivot the whole ledger onto one actor without typing a UUID. */
  const filterByActor = (row: AuditLedgerRow) => {
    const next = { ...draft, actorUserId: row.actorId };
    setDraft(next);
    setApplied(toFilters(next));
  };

  const columns: Column<AuditLedgerRow>[] = [
    {
      key: 'at',
      header: 'When',
      render: (r) => <span className="whitespace-nowrap">{new Date(r.at).toLocaleString()}</span>,
      exportValue: (r) => r.at,
    },
    { key: 'action', header: 'Action', render: (r) => <span className="font-medium text-ink-strong">{r.action}</span> },
    {
      key: 'actor',
      header: 'Actor',
      render: (r) => (
        <button
          type="button"
          onClick={() => filterByActor(r)}
          title="Show every action by this actor"
          className="text-left underline-offset-2 hover:underline"
        >
          <span className="block text-ink-strong">{r.actorName ?? r.actorId}</span>
          <span className="block text-xs text-ink-muted">{r.actorRole}</span>
        </button>
      ),
      exportValue: (r) => `${r.actorName ?? r.actorId} (${r.actorRole})`,
    },
    {
      key: 'actingAs',
      header: 'Acting as',
      render: (r) =>
        r.actedAsRole ? (
          <Badge tone="warning" title="Taken under backup authority">
            {r.actedAsRole}
          </Badge>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      exportValue: (r) => r.actedAsRole ?? '',
    },
    {
      key: 'zone',
      header: 'Zone',
      render: (r) =>
        r.zoneId === null ? (
          <span className="text-ink-muted" title="A pan-India action — it belongs to no single zone">
            Pan-India
          </span>
        ) : (
          <span>{r.zoneName ?? `Zone ${r.zoneId}`}</span>
        ),
      exportValue: (r) => (r.zoneId === null ? 'Pan-India' : (r.zoneName ?? `Zone ${r.zoneId}`)),
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (r) => (
        <span className="block">
          <span className="block text-ink">{r.entityType}</span>
          <span className="block truncate font-mono text-[11px] text-ink-muted" title={r.entityId}>
            {r.entityId}
          </span>
        </span>
      ),
      exportValue: (r) => `${r.entityType}:${r.entityId}`,
    },
    {
      key: 'change',
      header: 'Change',
      render: (r) => <MetadataCell metadata={r.metadata} />,
      exportValue: (r) =>
        metadataChanges(r.metadata)
          .map((c) => `${c.field}: ${format(c.from)} → ${format(c.to)}`)
          .join('; '),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => <span className="text-ink">{metadataReason(r.metadata) ?? '—'}</span>,
      exportValue: (r) => metadataReason(r.metadata) ?? '',
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Trail"
        subtitle="Every audited action, by actor, scope and time — the ledger behind who did what, in whose scope, when."
      />

      <SectionCard title="Filters">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Action">
            <SearchInput
              aria-label="Action"
              placeholder="e.g. BATCH_APPROVED"
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              data-testid="audit-filter-action"
            />
          </Field>
          <Field label="Entity type">
            <SearchInput
              aria-label="Entity type"
              placeholder="e.g. ticket"
              value={draft.entityType}
              onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              className="w-40"
              data-testid="audit-filter-entity-type"
            />
          </Field>
          <Field label="Entity ID">
            <SearchInput
              aria-label="Entity ID"
              placeholder="ticket / record id"
              value={draft.entityId}
              onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              data-testid="audit-filter-entity-id"
            />
          </Field>
          <Field label="Acted as">
            <FilterSelect
              aria-label="Acted as"
              value={draft.actedAsRole}
              onChange={(e) => setDraft({ ...draft, actedAsRole: e.target.value })}
              data-testid="audit-filter-acted-as"
            >
              <option value="">Any authority</option>
              <option value="ZONAL_MANAGER">Acting as ZM</option>
            </FilterSelect>
          </Field>
          {panIndia && (
            <Field label="Zone">
              <FilterSelect
                aria-label="Zone"
                value={draft.zoneId}
                onChange={(e) => setDraft({ ...draft, zoneId: e.target.value })}
                data-testid="audit-filter-zone"
              >
                <option value="">All zones</option>
                {zones.map((z) => (
                  <option key={z.zoneId} value={String(z.zoneId)}>
                    {z.name}
                  </option>
                ))}
              </FilterSelect>
            </Field>
          )}
          <Field label="From">
            <DateInput value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} label="From" testId="audit-filter-from" />
          </Field>
          <Field label="To">
            <DateInput value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} label="To" testId="audit-filter-to" />
          </Field>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={apply} data-testid="audit-apply">
              Apply
            </Button>
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          </div>
        </div>
        {!panIndia && (
          <p className="mt-3 text-xs text-ink-muted" data-testid="audit-zone-clamp-note">
            Showing your zone only — actions taken in your zone, on your zone&apos;s tickets, or by your
            zone&apos;s people.
          </p>
        )}
      </SectionCard>

      <DataTable
        ariaLabel="Audit ledger"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowTestId={(r) => `audit-row-${r.id}`}
        loading={loading}
        error={error}
        onRetry={load}
        stickyHeader
        exportName="Audit ledger"
        empty={<p className="py-6 text-center text-sm text-ink-muted">No audited actions match these filters.</p>}
        toolbarTitle={<span className="text-xs text-ink-muted">{rows.length} rows loaded</span>}
        toolbar={
          <Button
            variant="ghost"
            size="sm"
            disabled={!nextCursor}
            loading={loadingMore}
            onClick={loadMore}
            data-testid="audit-load-more"
          >
            {nextCursor ? 'Load more' : 'End of ledger'}
          </Button>
        }
      />
    </div>
  );
}

/** Labelled filter control — the label is the visible caps eyebrow, the control keeps its aria-label. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-caps">{label}</span>
      {children}
    </div>
  );
}

function DateInput({
  value,
  onChange,
  label,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  testId: string;
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      className="h-8 rounded-md border border-line bg-surface-card px-2 text-[13px] text-ink-strong shadow-sm hover:border-line-strong focus-visible:border-brand-600 focus-ring"
    />
  );
}

/**
 * #342 AC3 — `metadata` read as from/to where the writer recorded one. The shapes live in
 * `api/auditTrail.ts` so the drawer's Audit tab reads them identically; anything with no transition
 * in it falls back to the remaining key/value detail rather than being silently dropped.
 */
export function MetadataCell({ metadata }: { metadata: unknown }) {
  const changes = metadataChanges(metadata);
  const detail = metadataDetail(metadata);
  if (changes.length === 0 && !detail) return <span className="text-ink-muted">—</span>;
  return (
    <span className="block text-xs">
      {changes.map((c) => (
        <span key={c.field} className="block">
          <span className="text-ink-muted">{c.field}: </span>
          <span className="text-ink line-through decoration-ink-muted/60">{format(c.from)}</span>
          <span className="text-ink-muted"> → </span>
          <span className="font-medium text-ink-strong">{format(c.to)}</span>
        </span>
      ))}
      {detail && <span className="block text-ink-muted">{detail}</span>}
    </span>
  );
}
