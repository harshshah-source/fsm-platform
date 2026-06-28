import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../ui/Button';
import { IconBell, IconPlus, IconSearch } from '../ui/icons';
import { ROLE_LABEL } from './nav';

// Breadcrumb current-page label by route prefix (longest match wins). Chrome only — no behaviour.
const PAGE_TITLES: [string, string][] = [
  ['/tickets', 'Tickets'],
  ['/schedules', 'Schedules'],
  ['/intraday', 'Intra-day Queue'],
  ['/engineers/planner', 'SE Planner'],
  ['/engineers', 'SE Activity'],
  ['/leave-requests', 'Leave Requests'],
  ['/verification', 'Verification Review'],
  ['/readiness/vehicle-unavailability', 'Readiness & Vehicle Availability'],
  ['/readiness/non-operational', 'Non-Operational'],
  ['/readiness/recovery-decisions', 'Recovery Decisions'],
  ['/component-blocked', 'Component Blocked Queue'],
  ['/component-requests', 'Component Requests'],
  ['/warehouse/requests', 'Component Requests'],
  ['/warehouse/shadow-use', 'Shadow Use Queue'],
  ['/warehouse/recovery-receipt', 'Recovery Receipt'],
  ['/coverage', 'Coverage'],
  ['/reports/csm-approval-share', 'CSM Backup Share'],
  ['/help', 'Help Center'],
  ['/settings', 'Settings'],
];

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const hit = PAGE_TITLES.find(([prefix]) => pathname.startsWith(prefix));
  return hit ? hit[1] : 'Console';
}

/** Light top bar: breadcrumb + global search + Assign SE + acting control + notifications + user chip. */
export function TopBar() {
  const { session, logout, actingZone, setActingZone } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [zoneInput, setZoneInput] = useState('');
  if (!session) return null;

  const canAct =
    session.role === 'CENTRAL_SERVICE_MANAGER' || session.role === 'OPERATIONS_HEAD';
  const zoneLabel = session.zone_id === null ? 'All zones' : `Zone ${session.zone_id}`;
  const roleLabel = ROLE_LABEL[session.role] ?? session.role;

  const enterActing = (): void => {
    const z = Number(zoneInput);
    if (!Number.isNaN(z) && zoneInput.trim()) {
      setActingZone(z);
      setZoneInput('');
    }
  };

  return (
    <header className="flex h-14 items-center gap-4 border-b border-line bg-surface-card px-4">
      <div className="hidden items-center gap-1 text-xs text-ink-muted lg:flex">
        <span>FSM Command Console</span>
        <span aria-hidden>›</span>
        <span className="font-medium text-ink-strong">{titleFor(pathname)}</span>
      </div>

      <div className="relative hidden max-w-md flex-1 md:block">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          aria-label="Search"
          placeholder="Search ticket, vehicle, plant, device…"
          className="h-9 w-full rounded-full border border-line bg-surface-app pl-9 pr-3 text-sm text-ink-strong placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
        />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Button size="sm" className="gap-1" onClick={() => navigate('/')}>
          <IconPlus className="h-4 w-4" /> Assign SE
        </Button>

        {canAct && actingZone == null && (
          <span className="flex items-center gap-1 text-sm">
            <label htmlFor="acting-zone" className="text-ink-muted">
              Act as ZM
            </label>
            <input
              id="acting-zone"
              aria-label="Act as ZM for zone"
              value={zoneInput}
              onChange={(e) => setZoneInput(e.target.value)}
              placeholder="zone"
              className="w-16 rounded-md border border-line px-2 py-1 text-sm"
            />
            <Button type="button" size="sm" variant="secondary" onClick={enterActing}>
              Go
            </Button>
          </span>
        )}

        <button
          type="button"
          aria-label="Notifications"
          className="text-ink-muted hover:text-ink-strong"
        >
          <IconBell className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3">
          <div className="text-right leading-tight">
            <div className="text-sm font-medium text-ink-strong">{roleLabel}</div>
            <div className="text-xs text-ink-muted">{zoneLabel}</div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
