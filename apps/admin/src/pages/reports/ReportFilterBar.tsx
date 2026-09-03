import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiDeviceFilterOptions, type DeviceFilterOptions } from '../../api/devices';
import { apiEngineers, type EngineerListRow } from '../../api/engineers';
import { currentMonth, type ReportFilterField, type ReportRangeGranularity } from '../../api/reports';

/**
 * The report filter bar (#364), and the scope chip that proves the server agreed with it.
 *
 * Five report endpoints have accepted from / to / zone / company / plant / deviceType / SE since
 * Issues 41–43 and 90; every client called them bare. This is the control surface for those
 * parameters, shared by the four report pages so the same dimension is not spelled three ways.
 *
 * Three decisions are load-bearing:
 *
 * **1. Filter state lives in the URL.** `useSearchParams`, not `useState`. A filtered report is a
 * thing people send each other — "look at North for June" is a link or it is a paragraph of
 * instructions — and it is also what makes a row link into another report land *filtered* rather
 * than resetting to the default window. It costs nothing here and cannot be retrofitted later
 * without touching every control.
 *
 * **2. A page offers only the dimensions its endpoint reads.** The `fields` prop comes from
 * `REPORT_FILTER_FIELDS` in `api/reports.ts`, which is transcribed from the controller. A control
 * whose parameter the endpoint ignores is worse than a missing control: it returns the *unfiltered*
 * number under a filtered-looking UI, and nothing on screen says so.
 *
 * **3. The scope chip renders the server's echo, never the local pick** — see {@link ReportScope}.
 */

/** Every filter key the report pages put in the URL. `''` means "not filtered". */
export interface ReportFilters {
  /** Single-month pages (the Reports landing, whose hero KPI endpoint is single-month). */
  month: string;
  from: string;
  to: string;
  zoneId: string;
  companyId: string;
  plantId: string;
  deviceType: string;
  seId: string;
}

const EMPTY: ReportFilters = { month: '', from: '', to: '', zoneId: '', companyId: '', plantId: '', deviceType: '', seId: '' };

export type ReportFilterKey = keyof ReportFilters;

/**
 * Read/write the filter set in the query string. Unset keys are *removed* rather than written empty,
 * so a page with nothing picked has a clean URL and every endpoint keeps its own default window.
 */
export function useReportFilters(): {
  filters: ReportFilters;
  set: (key: ReportFilterKey, value: string) => void;
  clear: () => void;
  active: boolean;
} {
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => {
    const next = { ...EMPTY };
    for (const key of Object.keys(EMPTY) as ReportFilterKey[]) next[key] = params.get(key) ?? '';
    return next;
  }, [params]);

  const set = useCallback(
    (key: ReportFilterKey, value: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          // Picking a company invalidates a plant chosen under the previous one — leaving it would
          // send a (company, plant) pair that intersects to nothing and read as "no data in range".
          if (key === 'companyId') next.delete('plantId');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const clear = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of Object.keys(EMPTY)) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const active = (Object.keys(EMPTY) as ReportFilterKey[]).some((k) => filters[k] !== '');
  return { filters, set, clear, active };
}

export interface ReportFilterOptions {
  zones: { zoneId: number; name: string }[];
  companies: { companyId: number; name: string }[];
  plants: { plantId: number; name: string; companyId: number }[];
  engineers: { seId: string; name: string }[];
}

const NO_OPTIONS: ReportFilterOptions = { zones: [], companies: [], plants: [], engineers: [] };

/**
 * The dropdown option lists, from the caller's own scope.
 *
 * `/devices/filter-options` is the source rather than `/org/zones|companies|plants`: the org lists are
 * `OPERATIONS_HEAD`-only (`companies.controller.ts:20`, `plants.controller.ts:12`), so a ZM or CSM
 * opening a report would have got three empty dropdowns. `/devices/filter-options` is `READ_ROLES`
 * and already returns the distinct zones / companies / plants **present in the viewer's fleet**,
 * which is also the only honest option list: offering a company the viewer has no devices for
 * produces an empty report and no explanation.
 *
 * The engineer list is fetched only when the page actually offers an SE filter — two of the four
 * report pages do not, and an unused request on every page load is a cost with no reader.
 */
export function useReportFilterOptions(fields: readonly ReportFilterField[]): ReportFilterOptions {
  const [options, setOptions] = useState<ReportFilterOptions>(NO_OPTIONS);
  const wantsEngineers = fields.includes('seId');

  useEffect(() => {
    let live = true;
    // Options are decoration on someone else's page: a failure leaves the dropdowns empty and the
    // report itself renders exactly as before. It must never be the reason a report fails to load.
    apiDeviceFilterOptions()
      // Every field is shape-checked before it reaches state. A `.catch` does not cover a bad shape:
      // the request SUCCEEDED, and the `undefined.map` would then be thrown from inside the state
      // updater during render — which takes the whole report page down, not just the dropdown. This
      // is the failure mode that produced Round 2's one regression.
      .then((o: DeviceFilterOptions) => {
        if (!live) return;
        setOptions((prev) => ({
          ...prev,
          zones: Array.isArray(o?.zones) ? o.zones : [],
          companies: Array.isArray(o?.companies) ? o.companies : [],
          plants: Array.isArray(o?.plants) ? o.plants : [],
        }));
      })
      .catch(() => undefined);
    if (wantsEngineers) {
      apiEngineers()
        .then((rows: EngineerListRow[]) => {
          if (!live) return;
          const engineers = Array.isArray(rows) ? rows.map((r) => ({ seId: r.seId, name: r.name })) : [];
          setOptions((prev) => ({ ...prev, engineers }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [wantsEngineers]);

  return options;
}

const CONTROL =
  'h-8 rounded-md border border-line bg-surface-card px-2 text-[12px] text-ink-strong shadow-sm transition-colors ' +
  'hover:border-line-strong focus-visible:border-brand-600 focus-ring';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-caps">{label}</span>
      {children}
    </label>
  );
}

/**
 * `device_type` is a free-form `String` column with no enum, no catalogue table and no endpoint that
 * lists its distinct values (checked across the tree — `/devices/filter-options` returns zones,
 * companies and plants only). So it is a text box, not a dropdown: guessing a fixed list here would
 * be a control that silently cannot reach half the fleet. Committed on a short debounce so a typed
 * model number is one request, not seven.
 */
function DeviceTypeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const t = setTimeout(() => onChange(draft.trim()), 250);
    return () => clearTimeout(t);
  }, [draft, onChange]);

  return (
    <Field label="Device type">
      <input
        type="text"
        value={draft}
        placeholder="Any"
        onChange={(e) => setDraft(e.target.value)}
        className={`${CONTROL} w-28 placeholder:text-ink-muted`}
      />
    </Field>
  );
}

/**
 * The filter row inside the reference header band (refs 21 / 23 / 24 / 25). It renders only the
 * controls in `fields`, and the range control's *granularity* follows the endpoint: `/reports/root-cause`
 * and `/reports/zm-scorecard` parse `YYYY-MM` and 400 on a day, the other three parse `YYYY-MM-DD`.
 */
export function ReportFilterBar({
  fields,
  filters,
  set,
  clear,
  active,
  options,
  granularity,
  /** Single-month pages use one `month` control instead of a from/to pair. */
  singleMonth = false,
  testId,
}: {
  fields: readonly ReportFilterField[];
  filters: ReportFilters;
  set: (key: ReportFilterKey, value: string) => void;
  clear: () => void;
  active: boolean;
  options: ReportFilterOptions;
  granularity: ReportRangeGranularity;
  singleMonth?: boolean;
  testId: string;
}) {
  const has = (f: ReportFilterField) => fields.includes(f);
  const dateType = granularity === 'month' ? 'month' : 'date';
  // The plant list follows the company pick (the same rule the ticket queue uses) — a plant dropdown
  // spanning every company in the fleet is a scroll, not a filter.
  const plants = filters.companyId
    ? options.plants.filter((p) => String(p.companyId) === filters.companyId)
    : options.plants;

  return (
    <div data-testid={testId} className="flex flex-wrap items-end gap-2">
      {singleMonth ? (
        <Field label="Month">
          <input
            type="month"
            aria-label="Month"
            value={filters.month || currentMonth()}
            onChange={(e) => set('month', e.target.value)}
            className={`${CONTROL} w-32`}
          />
        </Field>
      ) : (
        has('from') && (
          <>
            <Field label="From">
              <input type={dateType} aria-label="From" value={filters.from} onChange={(e) => set('from', e.target.value)} className={`${CONTROL} w-32`} />
            </Field>
            <Field label="To">
              <input type={dateType} aria-label="To" value={filters.to} onChange={(e) => set('to', e.target.value)} className={`${CONTROL} w-32`} />
            </Field>
          </>
        )
      )}

      {has('zoneId') && (
        <Field label="Zone">
          <select aria-label="Zone" value={filters.zoneId} onChange={(e) => set('zoneId', e.target.value)} className={`${CONTROL} w-32`}>
            <option value="">All zones</option>
            {options.zones.map((z) => (
              <option key={z.zoneId} value={z.zoneId}>{z.name}</option>
            ))}
          </select>
        </Field>
      )}

      {has('companyId') && (
        <Field label="Company">
          <select aria-label="Company" value={filters.companyId} onChange={(e) => set('companyId', e.target.value)} className={`${CONTROL} w-36`}>
            <option value="">All companies</option>
            {options.companies.map((c) => (
              <option key={c.companyId} value={c.companyId}>{c.name}</option>
            ))}
          </select>
        </Field>
      )}

      {has('plantId') && (
        <Field label="Plant">
          <select aria-label="Plant" value={filters.plantId} onChange={(e) => set('plantId', e.target.value)} className={`${CONTROL} w-36`}>
            <option value="">All plants</option>
            {plants.map((p) => (
              <option key={p.plantId} value={p.plantId}>{p.name}</option>
            ))}
          </select>
        </Field>
      )}

      {has('deviceType') && <DeviceTypeInput value={filters.deviceType} onChange={(v) => set('deviceType', v)} />}

      {has('seId') && (
        <Field label="Engineer">
          <select aria-label="Engineer" value={filters.seId} onChange={(e) => set('seId', e.target.value)} className={`${CONTROL} w-36`}>
            <option value="">All engineers</option>
            {options.engineers.map((e) => (
              <option key={e.seId} value={e.seId}>{e.name}</option>
            ))}
          </select>
        </Field>
      )}

      {active && (
        <button
          type="button"
          onClick={clear}
          className="h-8 rounded-md border border-line px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink-strong focus-ring"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

/**
 * The scope chip in the header band — **rendered from the report's echoed `filters.zoneId`, never
 * from the local pick.**
 *
 * This is the half of #364 AC1 that is not obvious. `reports.service.ts` pins a Zonal Manager to
 * their own zone regardless of what was asked for —
 * `restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null)` at `:437`,
 * `:628` and `:690` — and echoes the *clamped* value back. A chip drawn from the dropdown would
 * therefore tell a ZM who picked North that they were reading North while the numbers on screen were
 * West's. That is not a cosmetic slip: every figure under it would be misattributed, and nothing
 * would look wrong.
 *
 * So the chip reads the answer, and when the answer differs from the question it says why rather than
 * silently swapping the label — a control that quietly ignores input teaches people to distrust all
 * of them.
 */
export function ReportScope({
  testId,
  requestedZoneId,
  echoedZoneId,
  zones,
  allLabel = 'All zones',
  fallback,
}: {
  testId: string;
  /** What the filter bar asked for (`''` = nothing picked). */
  requestedZoneId: string;
  /** What the report answered with — `null` when the report is not zone-scoped. */
  echoedZoneId: number | string | null | undefined;
  zones: { zoneId: number; name: string }[];
  allLabel?: string;
  /** Rendered in place of the "all zones" label when the page has a richer scope summary. */
  fallback?: ReactNode;
}) {
  const echoed = echoedZoneId === null || echoedZoneId === undefined || echoedZoneId === '' ? null : String(echoedZoneId);
  const clamped = requestedZoneId !== '' && echoed !== null && echoed !== requestedZoneId;
  const zoneName = (id: string) => zones.find((z) => String(z.zoneId) === id)?.name ?? `Zone ${id}`;

  return (
    <span
      data-testid={testId}
      data-clamped={clamped ? 'true' : 'false'}
      title={
        clamped
          ? `Your role is scoped to ${zoneName(echoed!)}; the zone filter was applied by the server as ${zoneName(echoed!)}.`
          : undefined
      }
      className="inline-flex items-center gap-1.5"
    >
      {echoed === null ? (
        (fallback ?? (
          <span className="rounded-full border border-info/30 bg-info-bg px-2 py-0.5 font-medium uppercase tracking-wide text-info">
            {allLabel}
          </span>
        ))
      ) : (
        <span className="rounded-full border border-info/30 bg-info-bg px-2 py-0.5 font-medium uppercase tracking-wide text-info">
          {zoneName(echoed)}
        </span>
      )}
      {clamped && (
        <span className="rounded-sm border border-warning/40 bg-warning-bg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">
          Scoped to your zone
        </span>
      )}
    </span>
  );
}
