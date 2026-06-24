import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

// PRD §318–345 page inventory. Built pages link; the rest are placeholders until their slice.
const NAV_ITEMS: { label: string; to?: string }[] = [
  { label: 'Zone Dashboard', to: '/' },
  { label: 'Schedules', to: '/schedules' },
  { label: 'Intra-day' },
  { label: 'Tickets', to: '/tickets' },
  { label: 'Engineers', to: '/engineers' },
  { label: 'Leave Requests', to: '/leave-requests' },
  { label: 'Verification', to: '/verification' },
  { label: 'Component-Blocked', to: '/component-blocked' },
  { label: 'Reports' },
];

export function AdminShell() {
  const { session, logout, actingZone, setActingZone } = useAuth();
  const [zoneInput, setZoneInput] = useState('');
  if (!session) {
    return null;
  }

  const zoneLabel = session.zone_id === null ? 'All zones' : `Zone ${session.zone_id}`;
  const isManager =
    session.role === 'ZONAL_MANAGER' ||
    session.role === 'CENTRAL_SERVICE_MANAGER' ||
    session.role === 'OPERATIONS_HEAD';
  // Backup cascade (Issue 27): a CSM / Operations Head may act in a ZM's scope for a chosen zone.
  const canAct = session.role === 'CENTRAL_SERVICE_MANAGER' || session.role === 'OPERATIONS_HEAD';

  const enterActing = () => {
    const z = Number(zoneInput);
    if (!Number.isNaN(z) && zoneInput.trim()) {
      setActingZone(z);
      setZoneInput('');
    }
  };

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
                <Link to="/reports/csm-approval-share" className="text-slate-700 hover:underline">
                  CSM Backup Share
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
          {canAct && actingZone == null && (
            <span className="flex items-center gap-1">
              <label htmlFor="acting-zone" className="text-slate-500">
                Act as ZM
              </label>
              <input
                id="acting-zone"
                aria-label="Act as ZM for zone"
                value={zoneInput}
                onChange={(e) => setZoneInput(e.target.value)}
                placeholder="zone"
                className="w-16 rounded border px-1 py-0.5"
              />
              <button type="button" onClick={enterActing} className="rounded border px-2 py-0.5">
                Go
              </button>
            </span>
          )}
          <span className="font-medium">{session.role}</span>
          <span className="text-slate-500">{zoneLabel}</span>
          <button type="button" onClick={logout} className="rounded border px-2 py-1">
            Log out
          </button>
        </header>
        {actingZone != null && (
          <div role="status" className="flex items-center justify-between bg-amber-100 px-6 py-2 text-sm text-amber-900">
            <span>
              Acting as Zonal Manager for Zone {actingZone} (audited as {session.role})
            </span>
            <button type="button" onClick={() => setActingZone(null)} className="rounded border border-amber-300 px-2 py-0.5">
              Exit acting mode
            </button>
          </div>
        )}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
