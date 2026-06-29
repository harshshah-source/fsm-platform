import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { IconClose, IconMenu } from '../ui/icons';
import { BrandLogo } from './BrandLogo';
import { useSidebar } from './SidebarContext';
import { buildNav } from './nav';

/**
 * Role-grouped primary navigation (reference chrome) with a production collapsible behaviour:
 *  - Desktop (≥lg): in-flow rail that animates between a labelled 14rem column and a 4.75rem icon rail;
 *    the collapse choice persists via {@link useSidebar}. Collapsed items keep their accessible name and
 *    surface a hover tooltip.
 *  - Mobile (<lg): an off-canvas drawer that slides in over a tap-to-dismiss backdrop and auto-closes on
 *    navigation. Collapse does not apply on mobile — the drawer is always fully labelled.
 *
 * The AutoPlant wordmark sits on a white brand band so it is colour-identical to the legacy reference;
 * the dark role-grouped nav below is unchanged in structure (every link still targets an existing route).
 */
export function Sidebar({ role }: { role: string }) {
  const { pathname } = useLocation();
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();
  const groups = buildNav(role);
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  // Collapsed-rail label tooltip. Rendered via a body portal so it escapes the rail's overflow clip and
  // the transformed (translate) ancestor that would otherwise contain a position:fixed child.
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showTip = (label: string) => (e: { currentTarget: HTMLElement }) => {
    if (!collapsed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hideTip = () => setTip(null);

  // The drawer is transient: dismiss it whenever the route changes so a tap-through never strands it open.
  useEffect(() => {
    closeMobile();
  }, [pathname, closeMobile]);

  return (
    <>
      {/* Tap-to-dismiss scrim — mobile drawer only. */}
      <div
        aria-hidden
        onClick={closeMobile}
        className={cn(
          'fixed inset-0 z-30 bg-black/40 transition-opacity duration-300 lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <nav
        aria-label="Primary"
        data-collapsed={collapsed}
        data-mobile-open={mobileOpen}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-chrome-900 text-chrome-text shadow-xl',
          'transition-[transform,width] duration-300 ease-in-out',
          'lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 lg:shadow-none',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'lg:w-[4.75rem]' : 'lg:w-64',
        )}
      >
        {/* Brand band — white, so the wordmark is colour-identical to the legacy reference. */}
        <div
          className={cn(
            'flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-card px-3',
            collapsed && 'lg:justify-center lg:px-2',
          )}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-card text-ink-strong transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 lg:flex"
          >
            <IconMenu className="h-[18px] w-[18px]" />
          </button>

          <BrandLogo className={cn('min-w-0', collapsed && 'lg:hidden')} />

          <button
            type="button"
            onClick={closeMobile}
            aria-label="Close menu"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-card text-ink-strong transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 lg:hidden"
          >
            <IconClose className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3">
          {groups.map((g) => (
            <div
              key={g.heading}
              className={cn(
                'mb-4 last:mb-0',
                collapsed && 'lg:mb-2 lg:border-t lg:border-chrome-700 lg:pt-2 lg:first:border-0 lg:first:pt-0',
              )}
            >
              <div
                className={cn(
                  'px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-chrome-muted',
                  collapsed && 'lg:sr-only',
                )}
              >
                {g.heading}
              </div>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.to);
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        aria-current={active ? 'page' : undefined}
                        onMouseEnter={showTip(item.label)}
                        onMouseLeave={hideTip}
                        onFocus={showTip(item.label)}
                        onBlur={hideTip}
                        className={cn(
                          'flex items-center gap-2.5 rounded-r-md border-l-2 px-2 py-1.5 text-[13px] transition-colors',
                          collapsed && 'lg:justify-center lg:gap-0 lg:px-0',
                          active
                            ? 'border-brand-600 bg-chrome-700 text-white'
                            : 'border-transparent text-chrome-text hover:bg-chrome-800 hover:text-white',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className={cn('truncate', collapsed && 'lg:sr-only')}>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div
          className={cn(
            'shrink-0 border-t border-chrome-700 px-4 py-3 text-[10px] text-chrome-muted',
            collapsed && 'lg:hidden',
          )}
        >
          Admin Console v2.0 · role-gated nav
        </div>
      </nav>

      {/* Collapsed-rail tooltip — body portal, desktop only (no hover affordance on the mobile drawer). */}
      {collapsed &&
        tip &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: 'fixed', top: tip.top, left: tip.left, transform: 'translateY(-50%)' }}
            className="z-[60] hidden whitespace-nowrap rounded-md bg-chrome-800 px-2 py-1 text-xs text-white shadow-lg lg:block"
          >
            {tip.label}
          </div>,
          document.body,
        )}
    </>
  );
}
