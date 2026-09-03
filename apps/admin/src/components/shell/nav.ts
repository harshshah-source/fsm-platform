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
  /**
   * #281 AC2 — the operator question this destination answers, rendered as visible copy under the
   * label. Only the Dispatch cluster carries one today: its four nouns are the set a new ZM provably
   * cannot rank (`audit/frontend-ux-audit-2026-08-19.md` finding 10), and a hint on every row in the
   * sidebar would be noise rather than ranking.
   */
  hint?: string;
  /**
   * #280 R9 — one indent, the smallest of the three presentational treatments that ruling names
   * (divider / indent / copy), used to say Intra-day Queue hangs off Schedules rather than standing
   * beside it as a fourth tense. Presentational only: the link, its route and its role gate are
   * untouched (#281 AC12).
   */
  indent?: boolean;
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
 * #281 AC1 — the heading the four dispatch surfaces sit under. Exported so the pages that belong to
 * the cluster and the tests that pin it name it from one place rather than repeating a string.
 */
export const DISPATCH_HEADING = 'Dispatch';

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
      // #281 — Schedules / Scheduler Preview / Dispatch Runs / Intra-day Queue left this list for the
      // `Dispatch` group below. They were adjacent here only because they were added in that order.
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

  // #281 (executes #280 R1/R8/R9) — the dispatch timeline as one named cluster, in the same grouped-rail
  // pattern the Settings console uses. The four surfaces are one concept read at four points in time:
  // what the next run WOULD do, what today's run committed, the changes made to that since, and the
  // ledger of what already ran. Grouping them ranks the nouns; the hints keep them distinct, which is
  // the constraint #280 R2 puts on any expression of the relationship — a projection must never read
  // as a commitment.
  if (isManager) {
    groups.push({
      heading: DISPATCH_HEADING,
      items: [
        // #285 — the cockpit, and the group's primary row. It answers "what is happening now", which
        // none of the four below could: Schedules is not date-scoped, Preview is a projection, the
        // ledger is history, and Intra-day reads an audit action the UI never writes. The four stay
        // as supporting and historical surfaces — #281's grouping and cross-links are what the deck
        // sits on, not something it replaces.
        {
          label: "Today's Dispatch",
          to: '/dispatch/today',
          icon: IconClock,
          hint: 'What is happening now',
        },
        // #251 — the pre-run twin of Schedules. Same manager roles; a ZM's projection is zone-clamped
        // server-side, so no extra nav gating is needed here.
        {
          label: 'Scheduler Preview',
          to: '/schedules/preview',
          icon: IconCalendar,
          hint: 'What the next run would do',
          indent: true,
        },
        { label: 'Schedules', to: '/schedules', icon: IconCalendar, hint: 'Committed day plans', indent: true },
        {
          label: 'Intra-day Queue',
          to: '/intraday',
          icon: IconClock,
          hint: "Changes to today's plan",
          indent: true,
        },
        { label: 'Dispatch Runs', to: '/dispatch-runs', icon: IconClipboard, hint: 'What past runs did', indent: true },
      ],
    });
  }

  if (isManager) {
    groups.push({
      heading: 'Components & Warehouse',
      items: [
        { label: 'Component Blocked', to: '/component-blocked', icon: IconBoxAlert },
        { label: 'Component Requests', to: '/component-requests', icon: IconPackage },
        // #353 — the manager's half of the Shadow Use Queue: the disputes a Warehouse Manager
        // escalated to them. Same route as the WM's queue, which renders the Disputes section alone
        // for a manager; without a link the escalation had no destination.
        { label: 'Shadow Use Disputes', to: '/warehouse/shadow-use', icon: IconShuffle },
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
    // #342 — the audit ledger sits with Analytics, not Admin: Admin is Operations-Head-only, and the
    // ZM is the role most often asked to account for an action taken in their zone. It is last in the
    // group because it is the surface you reach for after a report raised a question, not before.
    analytics.push({ label: 'Audit Trail', to: '/audit-trail', icon: IconSearch });
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
