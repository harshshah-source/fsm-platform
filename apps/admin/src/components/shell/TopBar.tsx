import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../ui/Button';
import { IconBell, IconMenu, IconPlus, IconSearch } from '../ui/icons';
import { useSidebar } from './SidebarContext';
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
  const { openMobile } = useSidebar();
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

  // Initials for the profile avatar — first + last word of the role label (e.g. "Operations Head" → "OH").
  const words = roleLabel.split(/\s+/).filter(Boolean);
  const initials = (
    words.length <= 1 ? roleLabel.slice(0, 2) : words[0][0] + words[words.length - 1][0]
  ).toUpperCase();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface-card px-4 shadow-sm lg:gap-4 lg:px-6">
      <button
        type="button"
        onClick={openMobile}
        aria-label="Open menu"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-ink-strong transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 lg:hidden"
      >
        <IconMenu className="h-[18px] w-[18px]" />
      </button>

      {/* Page identity — muted eyebrow over a prominent current-page title (clear "you are here"). */}
      <div className="hidden shrink-0 flex-col justify-center leading-tight lg:flex">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-caps">
          FSM Command Console
        </span>
        <span className="text-[15px] font-semibold leading-tight text-ink-strong">
          {titleFor(pathname)}
        </span>
      </div>

      <div className="relative hidden max-w-md flex-1 md:block">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-muted" />
        <input
          aria-label="Search"
          placeholder="Search ticket, vehicle, plant, device…"
          className="h-10 w-full rounded-lg border border-line bg-surface-app pl-10 pr-3 text-sm text-ink-strong transition-colors placeholder:text-ink-muted hover:border-line-strong hover:bg-surface-card focus-visible:border-brand-600 focus-visible:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" className="h-10 gap-1.5 px-4 shadow-sm" onClick={() => navigate('/')}>
          <IconPlus className="h-4 w-4" /> Assign SE
        </Button>

        {canAct && actingZone == null && (
          <span className="flex items-center gap-1.5 text-sm">
            <label htmlFor="acting-zone" className="hidden text-ink-muted lg:inline">
              Act as ZM
            </label>
            <input
              id="acting-zone"
              aria-label="Act as ZM for zone"
              value={zoneInput}
              onChange={(e) => setZoneInput(e.target.value)}
              placeholder="zone"
              className="h-10 w-16 rounded-md border border-line bg-surface-card px-2.5 text-sm text-ink-strong transition-colors placeholder:text-ink-muted hover:border-line-strong focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
            />
            <Button type="button" size="sm" variant="secondary" className="h-10" onClick={enterActing}>
              Go
            </Button>
          </span>
        )}

        <span aria-hidden className="mx-0.5 hidden h-8 w-px bg-line sm:block" />

        <button
          type="button"
          aria-label="Notifications"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
        >
          <IconBell className="h-[18px] w-[18px]" />
        </button>

        {/* Profile section — initials avatar (brand-tinted) + identity, grouped as a distinct card. */}
        <div className="flex h-10 items-center gap-2.5 rounded-lg border border-line bg-surface-card py-1 pl-1.5 pr-1.5 sm:pr-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-[11px] font-bold text-brand-700">
            {initials}
          </span>
          <div className="hidden leading-tight sm:block">
            <div className="text-sm font-semibold text-ink-strong">{roleLabel}</div>
            <div className="text-xs text-ink-muted">{zoneLabel}</div>
          </div>
        </div>

        <Button type="button" size="sm" variant="secondary" className="h-10" onClick={logout}>
          Log out
        </Button>
      </div>
    </header>
  );
}
