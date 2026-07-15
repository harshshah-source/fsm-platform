import { Link } from 'react-router-dom';

/**
 * Every footer link targets a route that exists in `AppRoutes.tsx`. Role-gated targets are safe for
 * all viewers: `RoleRoute` redirects an unauthorized role back to `/`.
 */
const COLUMNS: { heading: string; links: { label: string; to: string }[] }[] = [
  {
    heading: 'Command Center',
    links: [
      { label: 'Dashboard', to: '/' },
      { label: 'Tickets', to: '/tickets' },
      { label: 'Schedules', to: '/schedules' },
      { label: 'Verification', to: '/verification' },
    ],
  },
  {
    heading: 'Planning',
    links: [
      { label: 'SE Planner', to: '/engineers/planner' },
      { label: 'SE Activity', to: '/engineers' },
      { label: 'Coverage', to: '/coverage' },
      { label: 'Intra-day', to: '/intraday' },
    ],
  },
  {
    heading: 'Warehouse',
    links: [
      { label: 'Component Requests', to: '/component-requests' },
      { label: 'Shadow Use', to: '/warehouse/shadow-use' },
      { label: 'Recovery', to: '/readiness/recovery-decisions' },
      { label: 'Component Blocked', to: '/component-blocked' },
    ],
  },
  {
    heading: 'Governance',
    links: [
      { label: 'Settings', to: '/settings' },
      { label: 'Manage SEs', to: '/engineers/manage' },
      { label: 'Exports', to: '/exports' },
      { label: 'Help Center', to: '/help' },
    ],
  },
];

/** Dark application footer (reference chrome). Navigation columns + status row. */
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
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-3 text-xs sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-chrome-muted">
                {col.heading}
              </div>
              <ul className="space-y-1">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      to={l.to}
                      className="text-chrome-text transition-colors hover:text-white hover:underline"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
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
