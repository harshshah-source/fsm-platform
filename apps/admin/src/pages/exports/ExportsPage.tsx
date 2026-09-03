import { useEffect, useMemo, useState } from 'react';
import {
  apiEntityMappingSummary,
  downloadEntityMappingCsv,
  type EntityMappingSummary,
} from '../../api/exports';
import { apiExportVouchers, apiVouchers, type VoucherRow } from '../../api/vouchers';
import { currentMonth } from '../../api/reports';
import { downloadCsv } from '../../lib/csv';
import { PageHeader } from '../../components/data';
import { SectionCard } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';

/** `1200` → `₹1,200`. Whole rupees — a finance batch total is not read to the paisa on a hub card. */
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Operations-Head Exports (Issue 120). Card-based hub for raw-data downloads; the first card is the
 * per-device Entity Mapping CSV. The Ops-Head gate is route-level (`RoleRoute`); more export cards
 * slot into the same grid as they land.
 *
 * #364 — the second card is the monthly **finance voucher batch**. `GET /vouchers/export?month=` has
 * existed since Issue 59/60 and lived only on the Vouchers page, behind the review queue: the person
 * who runs the finance pull is not reviewing vouchers, they are here, and nothing here said the
 * export existed. Per §1 correction RPT-08 this is a hub card, not an integration — the export is
 * already built.
 */
export function ExportsPage() {
  const [summary, setSummary] = useState<EntityMappingSummary | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<string | null>(null);

  const [month, setMonth] = useState<string>(currentMonth());
  const [approved, setApproved] = useState<VoucherRow[] | null>(null);
  const [voucherDownloading, setVoucherDownloading] = useState(false);

  useEffect(() => {
    apiEntityMappingSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    let live = true;
    apiVouchers('APPROVED')
      // A payload that is not an array would take the card down with `undefined.filter`; an export
      // hub must degrade to "unknown", never to a blank page.
      .then((rows) => live && setApproved(Array.isArray(rows) ? rows : []))
      .catch(() => live && setApproved(null));
    return () => {
      live = false;
    };
  }, []);

  /**
   * The batch for the picked month, counted from the APPROVED queue.
   *
   * This deliberately reuses `GET /vouchers?status=APPROVED` rather than adding a summary endpoint.
   * The export's own predicate is `status = 'APPROVED' AND submitted_at ∈ month`
   * (`vouchers.service.ts:475-479`) and that queue returns exactly that population, unpaged, for the
   * Operations Head. Counting it here means the number on the card and the rows in the file are one
   * predicate evaluated once; a second endpoint would be a second implementation of it, free to
   * drift — and a batch count that disagrees with the batch is worse than no count.
   */
  const batch = useMemo(() => {
    if (approved === null) return null;
    const rows = approved.filter((v) => (v.submittedAt ?? '').slice(0, 7) === month);
    return { count: rows.length, total: rows.reduce((s, v) => s + Number(v.totalAmount ?? 0), 0) };
  }, [approved, month]);

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

  const onDownloadVouchers = async () => {
    setVoucherDownloading(true);
    setError(null);
    try {
      const out = await apiExportVouchers(month);
      downloadCsv(out.filename, out.csv);
    } catch {
      setError('Voucher export failed — please try again.');
    } finally {
      setVoucherDownloading(false);
    }
  };

  const hint = summary
    ? `${summary.rowCount.toLocaleString()} devices${
        summary.dataAsOf ? ` · data as of ${new Date(summary.dataAsOf).toLocaleString()}` : ''
      }`
    : 'One row per device across the fleet.';

  const voucherHint =
    batch === null
      ? 'Approved-voucher count unavailable.'
      : batch.count === 0
        ? `No approved vouchers submitted in ${month}.`
        : `${batch.count.toLocaleString()} approved vouchers · ${inr(batch.total)}`;

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

        <SectionCard title="Finance voucher batch (CSV)">
          <p className="mb-3 text-sm text-ink-muted">
            One row per approved expense line for the month — voucher, engineer, zone, plant, ticket,
            vehicle, submission time, voucher total and each item's category, amount and merchant.
            Approved vouchers only; a voucher already marked PAID has left the batch.
          </p>
          <label className="mb-3 flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-caps">Month</span>
            <input
              type="month"
              aria-label="Voucher month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-36 rounded-md border border-line bg-surface-card px-2 text-[13px] text-ink-strong shadow-sm hover:border-line-strong focus-visible:border-brand-600 focus-ring"
            />
          </label>
          <p data-testid="voucher-batch-hint" className="mb-4 text-xs font-medium text-ink-subtle">
            {voucherHint}
          </p>
          {/* An empty month has nothing to download; offering the button anyway hands the operator a
              header-only CSV and no explanation of why. */}
          <Button
            onClick={onDownloadVouchers}
            loading={voucherDownloading}
            disabled={batch === null || batch.count === 0}
            data-testid="download-voucher-batch"
          >
            Download CSV
          </Button>
        </SectionCard>
      </div>
    </section>
  );
}
