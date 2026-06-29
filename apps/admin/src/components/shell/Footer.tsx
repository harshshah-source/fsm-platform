const COLUMNS: { heading: string; links: string[] }[] = [
  { heading: 'Command Center', links: ['Dashboard', 'Tickets', 'Schedules', 'Verification'] },
  { heading: 'Planning', links: ['SE Planner', 'SE Activity', 'Coverage', 'Intra-day'] },
  { heading: 'Warehouse', links: ['Component Requests', 'Shadow Use', 'Recovery', 'Stock'] },
  { heading: 'Governance', links: ['Settings', 'Role Access', 'Audit Trail', 'Help Center'] },
];

/** Dark application footer (reference chrome). Static informational columns + status row. */
export function Footer() {
  return (
    <footer className="mt-auto bg-chrome-900 px-6 py-6 text-chrome-text">
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="text-sm font-bold tracking-tight text-brand-logo">autoplant Systems</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-chrome-muted">
            Field Management System
          </div>
          <p className="mt-2 text-xs text-chrome-muted">
            A premium command workspace for field service dispatch, SLA governance, readiness
            intelligence, verification, warehouse visibility, and zone performance.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-3 text-xs sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-chrome-muted">
                {col.heading}
              </div>
              <ul className="space-y-1">
                {col.links.map((l) => (
                  <li key={l} className="text-chrome-text">
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1 border-t border-chrome-700 pt-3 text-[11px] text-chrome-muted">
        <span>Admin Console v2.0</span>
        <span>Role-gated</span>
        <span>Live operations</span>
        <span>All zones</span>
      </div>
    </footer>
  );
}
