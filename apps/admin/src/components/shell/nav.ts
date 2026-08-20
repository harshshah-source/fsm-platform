import type { ComponentType, SVGProps } from 'react';
import {
  IconActivity,
  IconAlert,
  IconBoxAlert,
  IconCalendar,
  IconClipboard,
  IconClock,
  IconGrid,
  IconHelp,
  IconMapPin,
  IconPackage,
  IconPlus,
  IconRoute,
  IconRotate,
  IconSearch,
  IconSettings,
  IconShare,
  IconShield,
  IconShuffle,
  IconTicket,
  IconTruck,
} from '../ui/icons';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export interface NavLink {
  label: string;
  to: string;
  icon: Icon;
}
export interface NavGroup {
  heading: string;
  items: NavLink[];
}

/**
 * Server-resolved feature flags that change what the nav contains. Kept as an explicit parameter rather
 * than read from a context inside `buildNav`, so the function stays pure and directly unit-testable —
 * the existing nav tests call it with a role and nothing else, and all of them still do.
 */
export interface NavFeatures {
  /** `OPS_EXPLORER_ENABLED` on the backend (#217). Off ⇒ the link must not render at all. */
  opsExplorer?: boolean;
}

/**
 * Role-scoped, grouped navigation (the `RoleNav` concern). Mirrors the reference sidebar grouping and
 * the existing route map + RoleRoute gates — every link targets a route that already exists. Warehouse
 * Managers get the scoped Warehouse nav (reference `05`); managers get Operations + Components; only the
 * Operations Head sees the Admin group.
 */
export function buildNav(role: string, features: NavFeatures = {}): NavGroup[] {
  const isManager =
    role === 'ZONAL_MANAGER' || role === 'CENTRAL_SERVICE_MANAGER' || role === 'OPERATIONS_HEAD';
  const isOpsHead = role === 'OPERATIONS_HEAD';
  // #238 — the two roles that co-own the SE-assignment threshold. Not `isManager`: the ZM is the
  // graded party and the threshold moves the dispatch volume they are graded on.
  const ownsAssignmentThreshold = role === 'CENTRAL_SERVICE_MANAGER' || role === 'OPERATIONS_HEAD';

  // Help is reachable from the sidebar for every role (FE-26); the page itself scopes its content.
  const support: NavGroup = {
    heading: 'Support',
    items: [{ label: 'Help', to: '/help', icon: IconHelp }],
  };

  if (role === 'WAREHOUSE_MANAGER') {
    return [
      {
        heading: 'Warehouse',
        items: [
          { label: 'Dashboard', to: '/', icon: IconGrid },
          { label: 'Component Requests', to: '/warehouse/requests', icon: IconPackage },
          { label: 'Shadow Use Queue', to: '/warehouse/shadow-use', icon: IconShuffle },
          { label: 'Recovery Receipt', to: '/warehouse/recovery-receipt', icon: IconRotate },
        ],
      },
      support,
    ];
  }

  const operations: NavLink[] = [
    { label: 'Zone Dashboard', to: '/', icon: IconGrid },
    { label: 'Tickets', to: '/tickets', icon: IconTicket },
  ];
  if (isManager) {
    operations.push(
      // #273 — first in the manager list: handing out work is the job the console exists for, and it
      // is what the top-bar `Assign SE` button now opens.
      { label: 'Assign Work', to: '/assign', icon: IconPlus },
      { label: 'Create Install', to: '/install', icon: IconTruck },
      { label: 'Schedules', to: '/schedules', icon: IconCalendar },
      // #251 — the pre-run twin of Schedules (which shows what WAS dispatched). Same manager roles;
      // a ZM's projection is zone-clamped server-side, so no extra nav gating is needed here.
      { label: 'Scheduler Preview', to: '/schedules/preview', icon: IconCalendar },
      { label: 'Dispatch Runs', to: '/dispatch-runs', icon: IconClipboard },
      { label: 'Intra-day Queue', to: '/intraday', icon: IconClock },
      { label: 'SE Activity', to: '/engineers', icon: IconActivity },
      { label: 'Manage SEs', to: '/engineers/manage', icon: IconShield },
      { label: 'SE Planner', to: '/engineers/planner', icon: IconRoute },
      { label: 'Verification Review', to: '/verification', icon: IconShield },
      { label: 'Readiness & Vehicle', to: '/readiness/vehicle-unavailability', icon: IconTruck },
      { label: 'Non-Operational', to: '/readiness/non-operational', icon: IconAlert },
      { label: 'Cross-Zone', to: '/cross-zone', icon: IconShare },
      { label: 'Tier Overrides', to: '/tier-overrides', icon: IconShield },
      { label: 'Recovery Decisions', to: '/readiness/recovery-decisions', icon: IconRotate },
      { label: 'Leave Requests', to: '/leave-requests', icon: IconClipboard },
      { label: 'Expense Vouchers', to: '/vouchers', icon: IconClipboard },
    );
  }

  const groups: NavGroup[] = [{ heading: 'Operations', items: operations }];

  if (isManager) {
    groups.push({
      heading: 'Components & Warehouse',
      items: [
        { label: 'Component Blocked', to: '/component-blocked', icon: IconBoxAlert },
        { label: 'Component Requests', to: '/component-requests', icon: IconPackage },
      ],
    });
  }

  if (isManager) {
    const analytics: NavLink[] = [
      { label: 'Reports', to: '/reports', icon: IconGrid },
      { label: 'Device Detail', to: '/reports/device', icon: IconTicket },
      { label: 'Commissioning Cohort', to: '/reports/commissioning', icon: IconActivity },
      { label: 'Root Cause Analytics', to: '/reports/root-cause', icon: IconActivity },
      { label: 'System Efficiency', to: '/reports/system-efficiency', icon: IconActivity },
    ];
    if (isOpsHead) analytics.push({ label: 'ZM Scorecard', to: '/reports/zm-scorecard', icon: IconShield });
    groups.push({ heading: 'Analytics', items: analytics });
  }

  // #238 — the co-owned engine policy. Its own group rather than a row in Admin (which the CSM never
  // sees) or in Operations (which is per-instance execution, not configuration): this is the one
  // platform-wide dial a CSM may move, and burying it in either list would misstate what it is.
  if (ownsAssignmentThreshold) {
    groups.push({
      heading: 'Policy',
      items: [{ label: 'SE Assignment Threshold', to: '/assignment-threshold', icon: IconClock }],
    });
  }

  if (isOpsHead) {
    // #217 — the explorer link appears only when the backend reports the feature enabled. Role alone is
    // not enough: with the flag off every one of its endpoints 404s, so a link would be a dead end.
    const opsExplorer: NavLink[] = features.opsExplorer
      ? [{ label: 'Data Explorer', to: '/ops-explorer', icon: IconSearch }]
      : [];
    groups.push({
      heading: 'Admin',
      items: [
        ...opsExplorer,
        { label: 'Coverage', to: '/coverage', icon: IconMapPin },
        { label: 'CSM Backup Share', to: '/reports/csm-approval-share', icon: IconShare },
        { label: 'Bulk Unassign', to: '/bulk-unassign', icon: IconShuffle },
        { label: 'Plant Deactivations', to: '/plant-deactivations', icon: IconBoxAlert },
        { label: 'Plant Zones', to: '/plant-zones', icon: IconMapPin },
        { label: 'Exports', to: '/exports', icon: IconClipboard },
        { label: 'Build Health', to: '/build-health', icon: IconActivity },
        { label: 'Settings', to: '/settings', icon: IconSettings },
      ],
    });
  }

  groups.push(support);

  return groups;
}

export const ROLE_LABEL: Record<string, string> = {
  SERVICE_ENGINEER: 'Service Engineer',
  ZONAL_MANAGER: 'Zonal Manager',
  CENTRAL_SERVICE_MANAGER: 'Central Service Manager',
  OPERATIONS_HEAD: 'Operations Head',
  WAREHOUSE_MANAGER: 'Warehouse Manager',
};
