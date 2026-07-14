import { useEffect, useState } from 'react';
import {
  apiEntityMappingSummary,
  downloadEntityMappingCsv,
  type EntityMappingSummary,
} from '../../api/exports';
import { PageHeader } from '../../components/data';
import { SectionCard } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';

/**
 * Operations-Head Exports (Issue 120). Card-based hub for raw-data downloads; the first card is the
 * per-device Entity Mapping CSV. The Ops-Head gate is route-level (`RoleRoute`); more export cards
 * slot into the same grid as they land.
 */
export function ExportsPage() {
  const [summary, setSummary] = useState<EntityMappingSummary | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<string | null>(null);

  useEffect(() => {
    apiEntityMappingSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  const onDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadEntityMappingCsv();
      setLastDownloaded(new Date().toLocaleString());
    } catch {
      setError('Download failed — please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const hint = summary
    ? `${summary.rowCount.toLocaleString()} devices${
        summary.dataAsOf ? ` · data as of ${new Date(summary.dataAsOf).toLocaleString()}` : ''
      }`
    : 'One row per device across the fleet.';

  return (
    <section>
      <PageHeader
        title="Exports"
        subtitle="Operations-Head raw-data downloads for reconciliation and offline analysis."
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <SectionCard title="Entity mapping (CSV)">
          <p className="mb-3 text-sm text-ink-muted">
            One row per device — vehicle, company, plant, zone (with source), transporter, deployment
            and FSM status, SLA bucket, uptime eligibility, and open-ticket count.
          </p>
          <p data-testid="entity-mapping-hint" className="mb-4 text-xs font-medium text-ink-subtle">
            {hint}
          </p>
          <Button
            onClick={onDownload}
            loading={downloading}
            data-testid="download-entity-mapping"
          >
            Download CSV
          </Button>
          {lastDownloaded && (
            <p className="mt-3 text-xs text-ink-subtle">Last downloaded {lastDownloaded}</p>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
