import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

// PRD §318–345 page inventory. Built pages link; the rest are placeholders until their slice.
const NAV_ITEMS: { label: string; to?: string }[] = [
  { label: 'Zone Dashboard', to: '/' },
  { label: 'Schedules', to: '/schedules' },
  { label: 'Intra-day' },
  { label: 'Tickets', to: '/tickets' },
  { label: 'Engineers', to: '/engineers' },
  { label: 'Verification', to: '/verification' },
  { label: 'Component-Blocked', to: '/component-blocked' },
  { label: 'Reports' },
];

export function AdminShell() {
  const { session, logout } = useAuth();
  if (!session) {
    return null;
  }

  const zoneLabel = session.zone_id === null ? 'All zones' : `Zone ${session.zone_id}`;
  const isManager =
    session.role === 'ZONAL_MANAGER' ||
    session.role === 'CENTRAL_SERVICE_MANAGER' ||
    session.role === 'OPERATIONS_HEAD';

  return (
    <div className="flex min-h-screen">
      <nav aria-label="Primary" className="w-56 shrink-0 border-r bg-slate-50 p-4">
        <div className="mb-4 text-lg font-semibold">FSM Admin</div>
        <ul className="flex flex-col gap-1 text-sm text-slate-500">
          {NAV_ITEMS.map((item) => (
            <li key={item.label} className="rounded px-2 py-1">
              {item.to ? (
                <Link to={item.to} className="text-slate-700 hover:underline">
                  {item.label}
                </Link>
              ) : (
                item.label
              )}
            </li>
          ))}
          {/* Component Requests is the Warehouse Manager queue (Issue 22); WM only — the
              /warehouse/requests route is RoleRoute-gated as the matching second line of defence. */}
          {session.role === 'WAREHOUSE_MANAGER' && (
            <>
              <li className="rounded px-2 py-1">
                <Link to="/warehouse/requests" className="text-slate-700 hover:underline">
                  Component Requests
                </Link>
              </li>
              <li className="rounded px-2 py-1">
                <Link to="/warehouse/shadow-use" className="text-slate-700 hover:underline">
                  Shadow Use Queue
                </Link>
              </li>
            </>
          )}
          {/* Component Requests oversight — manager read-only visibility (Issue 23); the
              /component-requests route is RoleRoute-gated as the matching second line of defence. */}
          {isManager && (
            <li className="rounded px-2 py-1">
              <Link to="/component-requests" className="text-slate-700 hover:underline">
                Component Requests
              </Link>
            </li>
          )}
          {/* SE Planner is a ZM plant-visit scheduling tool (Issue 14b); manager roles only — the
              /engineers/planner route is RoleRoute-gated as the matching second line of defence. */}
          {isManager && (
            <li className="rounded px-2 py-1">
              <Link to="/engineers/planner" className="text-slate-700 hover:underline">
                SE Planner
              </Link>
            </li>
          )}
          {/* Settings is Operations-Head-only (Issue 02 AC#1); other roles never see the link
              and the /settings route is RoleRoute-gated as the second line of defence. */}
          {session.role === 'OPERATIONS_HEAD' && (
            <>
              <li className="rounded px-2 py-1">
                <Link to="/coverage" className="text-slate-700 hover:underline">
                  Coverage
                </Link>
              </li>
              <li className="rounded px-2 py-1">
                <Link to="/settings" className="text-slate-700 hover:underline">
                  Settings
                </Link>
              </li>
            </>
          )}
        </ul>
      </nav>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b px-6 py-3 text-sm">
          {session.acted_as_role && (
            <span role="status" className="rounded bg-amber-100 px-2 py-1 text-amber-800">
              Acting as {session.acted_as_role}
            </span>
          )}
          <span className="font-medium">{session.role}</span>
          <span className="text-slate-500">{zoneLabel}</span>
          <button type="button" onClick={logout} className="rounded border px-2 py-1">
            Log out
          </button>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
