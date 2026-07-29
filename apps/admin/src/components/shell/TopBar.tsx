import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { emitIngestionComplete } from '../../pages/dashboard/ingestionEvents';
import { RunIngestionButton } from '../../pages/dashboard/RunIngestionButton';
import { Button } from '../ui/Button';
import { IconBell, IconMenu, IconPlus, IconSearch } from '../ui/icons';
import { resolveBreadcrumb } from './breadcrumb';
import { useSidebar } from './SidebarContext';
import { ThemeToggle } from './ThemeToggle';
import { ROLE_LABEL } from './nav';

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
    <header className="sticky top-0 z-20 flex h-[4.25rem] items-center gap-3 border-b border-line bg-surface-card/90 px-4 shadow-card backdrop-blur-xl lg:gap-4 lg:px-6">
      <button
        type="button"
        onClick={openMobile}
        aria-label="Open menu"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-ink-strong transition-colors hover:bg-surface-sunken focus-ring lg:hidden"
      >
        <IconMenu className="h-[18px] w-[18px]" />
      </button>

      <nav aria-label="Breadcrumb" className="hidden shrink-0 items-center gap-1.5 lg:flex">
        {resolveBreadcrumb(pathname, session.role).map((crumb, index, crumbs) => {
          const isLast = index === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden className="text-ink-muted">
                  ›
                </span>
              )}
              {!isLast && crumb.to ? (
                <Link
                  to={crumb.to}
                  className="text-[13px] text-ink-muted transition-colors hover:text-ink-strong"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={
                    isLast
                      ? 'text-[15px] font-semibold leading-tight text-ink-strong'
                      : 'text-[13px] text-ink-muted'
                  }
                >
                  {crumb.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>

      {/* `min-w-0` matters: without it this flex item cannot shrink below the input's intrinsic size,
          so on a long breadcrumb the overflow was pushed into the buttons on the right and wrapped
          their labels ("Assign SE" over two lines). The search is the one item that should absorb it. */}
      <div className="relative hidden min-w-0 max-w-md flex-1 md:block">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-muted" />
        <input
          aria-label="Search"
          placeholder="Search ticket, vehicle, plant, device…"
          className="h-10 w-full rounded-md border border-line bg-surface-raised/80 pl-10 pr-3 text-sm text-ink-strong shadow-sm transition-[background-color,border-color,box-shadow] placeholder:text-ink-muted hover:border-line-strong hover:bg-surface-card focus-visible:border-brand-600 focus-ring"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Operations-Head manual ingestion trigger — self-gates to OPERATIONS_HEAD (renders null for
            everyone else). On a completed run it broadcasts so the OH dashboard rolls its KPIs. */}
        <RunIngestionButton onSuccess={emitIngestionComplete} />

        <Button size="sm" className="h-10 shrink-0 gap-1.5 whitespace-nowrap px-4 shadow-sm" onClick={() => navigate('/')}>
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
              className="h-10 w-16 rounded-md border border-line bg-surface-card px-2.5 text-sm text-ink-strong shadow-sm transition-colors placeholder:text-ink-muted hover:border-line-strong focus-visible:border-brand-600 focus-ring"
            />
            <Button type="button" size="sm" variant="secondary" className="h-10" onClick={enterActing}>
              Go
            </Button>
          </span>
        )}

        <span aria-hidden className="mx-0.5 hidden h-8 w-px bg-line sm:block" />

        <ThemeToggle />

        <button
          type="button"
          aria-label="Notifications"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink-strong focus-ring"
        >
          <IconBell className="h-[18px] w-[18px]" />
        </button>

        {/* Profile section — initials avatar (brand-tinted) + identity, grouped as a distinct card. */}
        <div className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-surface-card py-1 pl-1.5 pr-1.5 shadow-card sm:pr-3">
          {/* `text-brand-700` is the deep crimson that reads on the light pink wash; on the dark
              card that wash resolves to a muted mauve, so the initials take the light end instead. */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-300/40 text-[11px] font-bold text-brand-700 ring-1 ring-brand-300/70 dark:bg-brand-600/25 dark:text-brand-300 dark:ring-brand-600/40">
            {initials}
          </span>
          <div className="hidden leading-tight sm:block">
            <div className="whitespace-nowrap text-sm font-semibold text-ink-strong">{roleLabel}</div>
            <div className="text-xs text-ink-muted">{zoneLabel}</div>
          </div>
        </div>

        <Button type="button" size="sm" variant="secondary" className="h-10 shrink-0 whitespace-nowrap" onClick={logout}>
          Log out
        </Button>
      </div>
    </header>
  );
}
