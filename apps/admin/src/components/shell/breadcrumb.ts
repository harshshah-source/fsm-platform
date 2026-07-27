import { buildNav, type NavLink } from './nav';

export interface Crumb {
  label: string;
  to?: string;
}

function findNavLabel(navItems: NavLink[], to: string, fallback: string): string {
  return navItems.find((item) => item.to === to)?.label ?? fallback;
}

interface DetailCrumbEntry {
  pattern: RegExp;
  build: (match: RegExpMatchArray, navItems: NavLink[]) => Crumb[];
}

/**
 * Six entries covering every shell route absent from `buildNav` — net-zero replacement for the
 * deleted `PAGE_TITLES`. Order matters: the zone-nested dispatch-run pattern must be checked before
 * the plain run pattern, since both would otherwise match a `/dispatch-runs/:runId/zones/:zoneId`
 * pathname.
 */
const DETAIL_CRUMBS: DetailCrumbEntry[] = [
  {
    pattern: /^\/dispatch-runs\/([^/]+)\/zones\/([^/]+)$/,
    build: ([, runId, zoneId], navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/dispatch-runs', 'Dispatch Runs'), to: '/dispatch-runs' },
      { label: `Run #${runId}`, to: `/dispatch-runs/${runId}` },
      { label: `Zone ${zoneId}` },
    ],
  },
  {
    pattern: /^\/dispatch-runs\/([^/]+)$/,
    build: ([, runId], navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/dispatch-runs', 'Dispatch Runs'), to: '/dispatch-runs' },
      { label: `Run #${runId}` },
    ],
  },
  {
    pattern: /^\/tickets\/([^/]+)$/,
    build: ([, ticketId], navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/tickets', 'Tickets'), to: '/tickets' },
      { label: `Ticket #${ticketId}` },
    ],
  },
  {
    pattern: /^\/schedules\/([^/]+)$/,
    build: (_match, navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/schedules', 'Schedules'), to: '/schedules' },
      { label: 'Schedule Detail' },
    ],
  },
  {
    pattern: /^\/batches\/([^/]+)$/,
    build: ([, batchId], navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/dispatch-runs', 'Dispatch Runs'), to: '/dispatch-runs' },
      { label: `Batch #${batchId}` },
    ],
  },
  {
    pattern: /^\/reports\/fleet$/,
    build: (_match, navItems) => [
      { label: 'Dashboard', to: '/' },
      { label: findNavLabel(navItems, '/reports', 'Reports'), to: '/reports' },
      { label: 'Fleet Directory' },
    ],
  },
];

/**
 * Pure breadcrumb resolver — no React, unit-testable without a router. Crumb[0] is always the
 * literal "Dashboard" (never the role-varying nav label, which is "Zone Dashboard" for managers).
 */
export function resolveBreadcrumb(pathname: string, role: string): Crumb[] {
  if (pathname === '/') return [{ label: 'Dashboard' }];

  const navItems = buildNav(role).flatMap((group) => group.items);

  for (const entry of DETAIL_CRUMBS) {
    const match = entry.pattern.exec(pathname);
    if (match) return entry.build(match, navItems);
  }

  const navMatches = navItems.filter(
    (item) => item.to !== '/' && (pathname === item.to || pathname.startsWith(`${item.to}/`)),
  );
  navMatches.sort((a, b) => b.to.length - a.to.length);
  const best = navMatches[0];

  if (best) {
    if (pathname === best.to) {
      return [{ label: 'Dashboard', to: '/' }, { label: best.label }];
    }
    return [{ label: 'Dashboard', to: '/' }, { label: best.label, to: best.to }];
  }

  return [{ label: 'Dashboard', to: '/' }, { label: 'Console' }];
}
