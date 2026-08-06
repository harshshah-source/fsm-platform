import { SectionCard, Badge, Button } from '../../components/ui';
import { ErrorState, Skeleton } from '../../components/data';
import { useApiResource } from '../../hooks';
import { apiOpsExplorerReconciliation, type ReconciliationIdentity } from '../../api/opsExplorer';
import { formatDateTimeWithYear } from '../../lib/datetime';

/**
 * KPI reconciliation (#217 AC-10/AC-11).
 *
 * Every identity renders both sides *and how each side was measured*, because "3,476 = 3,476" only
 * means something once you know the two numbers were counted differently. A passing identity therefore
 * still shows its two `measuredBy` lines — that is the evidence, not decoration.
 *
 * A failing identity leads with the signed difference and the server's ranked candidate explanations.
 * The difference is signed on purpose: `+12` (the roll-up over-counts) and `-12` (rows missing from the
 * roll-up) have completely different causes, and an absolute value would throw that away.
 */
export function ReconciliationPanel() {
  const { data, loading, error, refetch } = useApiResource(
    () => apiOpsExplorerReconciliation(),
    [],
    'Failed to run reconciliation',
  );

  return (
    <SectionCard
      title="KPI reconciliation"
      action={
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-[11px] text-ink-muted">
              {formatDateTimeWithYear(data.checkedAt)} · {data.durationMs} ms
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={refetch} loading={loading}>
            Re-check
          </Button>
        </div>
      }
    >
      {loading && <Skeleton className="h-24 w-full" />}
      {!loading && error && <ErrorState message={error} onRetry={refetch} />}
      {!loading && !error && data && (
        <div className="space-y-3" data-testid="ops-explorer-reconciliation">
          <div className="flex items-center gap-2">
            <Badge tone={data.status === 'PASS' ? 'success' : 'critical'}>
              {data.status === 'PASS' ? 'All identities hold' : 'Mismatch detected'}
            </Badge>
            <span className="text-xs text-ink-muted">
              {data.identities.filter((i) => i.status === 'PASS').length}/{data.identities.length} passing
            </span>
          </div>
          {data.identities.map((identity) => (
            <Identity key={identity.key} identity={identity} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function Identity({ identity }: { identity: ReconciliationIdentity }) {
  const failed = identity.status === 'FAIL';
  return (
    <div
      data-testid={`reconciliation-${identity.key}`}
      className={`rounded-card border p-3 ${failed ? 'border-critical/40 bg-critical-bg/40' : 'border-line bg-surface-sunken/40'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink-strong">{identity.name}</span>
        <Badge tone={failed ? 'critical' : 'success'}>{identity.status}</Badge>
      </div>
      <code className="mt-1 block font-mono text-[11px] text-ink-muted">{identity.statement}</code>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Side term={identity.left} />
        <Side term={identity.right} />
      </div>

      {failed && (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-semibold text-critical">
            Difference: {identity.difference > 0 ? '+' : ''}
            {identity.difference.toLocaleString()} row{Math.abs(identity.difference) === 1 ? '' : 's'}
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-ink">
            {identity.likelySources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      )}

      {identity.sql && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-brand-700">
            Developer mode — the two statements
          </summary>
          <pre className="mt-1 overflow-x-auto rounded-md bg-surface-sunken p-2 font-mono text-[10.5px] text-ink">
            {`-- ${identity.left.label}\n${identity.sql.left}\n\n-- ${identity.right.label}\n${identity.sql.right}`}
          </pre>
        </details>
      )}
    </div>
  );
}

function Side({ term }: { term: ReconciliationIdentity['left'] }) {
  return (
    <div className="rounded-md border border-line bg-surface-card px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{term.label}</div>
      <div className="text-lg font-semibold tabular-nums text-ink-strong">{term.value.toLocaleString()}</div>
      <div className="text-[10.5px] leading-snug text-ink-muted">measured by {term.measuredBy}</div>
    </div>
  );
}
