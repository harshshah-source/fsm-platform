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
  IconRoute,
  IconRotate,
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
 * Role-scoped, grouped navigation (the `RoleNav` concern). Mirrors the reference sidebar grouping and
 * the existing route map + RoleRoute gates — every link targets a route that already exists. Warehouse
 * Managers get the scoped Warehouse nav (reference `05`); managers get Operations + Components; only the
 * Operations Head sees the Admin group.
 */
export function buildNav(role: string): NavGroup[] {
  const isManager =
    role === 'ZONAL_MANAGER' || role === 'CENTRAL_SERVICE_MANAGER' || role === 'OPERATIONS_HEAD';
  const isOpsHead = role === 'OPERATIONS_HEAD';

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
      { label: 'Schedules', to: '/schedules', icon: IconCalendar },
      { label: 'Intra-day Queue', to: '/intraday', icon: IconClock },
      { label: 'SE Activity', to: '/engineers', icon: IconActivity },
      { label: 'SE Planner', to: '/engineers/planner', icon: IconRoute },
      { label: 'Verification Review', to: '/verification', icon: IconShield },
      { label: 'Readiness & Vehicle', to: '/readiness/vehicle-unavailability', icon: IconTruck },
      { label: 'Non-Operational', to: '/readiness/non-operational', icon: IconAlert },
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

  if (isOpsHead) {
    groups.push({
      heading: 'Admin',
      items: [
        { label: 'Coverage', to: '/coverage', icon: IconMapPin },
        { label: 'CSM Backup Share', to: '/reports/csm-approval-share', icon: IconShare },
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
