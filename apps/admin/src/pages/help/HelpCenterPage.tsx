import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { ROLE_LABEL } from '../../components/shell/nav';
import { PageHeader } from '../../components/data';
import { Card, SectionCard } from '../../components/ui';

/**
 * FE-26 — Help Center (reference 27). A static, role-aware documentation surface: grouped topic cards
 * (Your module / Components & Warehouse / Analytics / Admin) each with a "View Docs" link, plus a
 * "Model states & terminology" glossary. No backend — visibility mirrors the nav's role logic
 * (managers see Analytics; only the Operations Head sees Admin; the Warehouse Manager is scoped to
 * their own module). "View Docs" links to the in-app destination the topic documents.
 */
interface HelpTopic {
  title: string;
  description: string;
  /** In-app route the topic documents — the "View Docs" target. */
  to: string;
}
interface HelpGroup {
  heading: string;
  topics: HelpTopic[];
}

const MANAGER_MODULE: HelpTopic[] = [
  { title: 'Zone Dashboard', description: 'Action-Required panel, zone overview, and the critical queue for your zone.', to: '/' },
  { title: 'Tickets', description: 'Filter the ticket list and open the detail drawer for lifecycle, verification, and components.', to: '/tickets' },
  { title: 'Schedules', description: 'Monitor batch schedules and apply manager overrides (auto-assigned framing).', to: '/schedules' },
  { title: 'Intra-day Queue', description: 'Same-day manual updates; system-inserted CRITICAL items land here.', to: '/intraday' },
  { title: 'SE Activity', description: 'Derived activity status per engineer and Set-Availability controls.', to: '/engineers' },
  { title: 'SE Planner', description: 'Plant-visit intent grid for planning floating and dedicated coverage.', to: '/engineers/planner' },
  { title: 'Verification Review', description: 'GPS verification review for completed visits.', to: '/verification' },
  { title: 'Readiness & Vehicle', description: 'Dual-SLA-clock review of vehicle unavailability and readiness blocks.', to: '/readiness/vehicle-unavailability' },
  { title: 'Non-Operational', description: 'Dual-confirmation queue; override-confirm is Operations-Head-only.', to: '/readiness/non-operational' },
  { title: 'Recovery Decisions', description: 'Unable-to-collect triage and the ZM decision queue.', to: '/readiness/recovery-decisions' },
  { title: 'Leave Requests', description: 'Review and approve engineer leave for your zone.', to: '/leave-requests' },
];

const WAREHOUSE_MODULE: HelpTopic[] = [
  { title: 'Warehouse Dashboard', description: 'Zone warehouse fulfilment KPIs, component-request and shadow-use panels.', to: '/' },
  { title: 'Component Requests', description: 'Approve and ship component requests raised from the field.', to: '/warehouse/requests' },
  { title: 'Shadow Use Queue', description: 'Reconcile consumption that lost the allocation race.', to: '/warehouse/shadow-use' },
  { title: 'Recovery Receipt', description: 'Confirm physical receipt to auto-close recovery tickets.', to: '/warehouse/recovery-receipt' },
];

const COMPONENTS_GROUP: HelpTopic[] = [
  { title: 'Component Blocked Queue', description: 'Read-only view of tickets blocked awaiting components.', to: '/component-blocked' },
  { title: 'Component Requests (oversight)', description: 'Read-only oversight of requests across your scope.', to: '/component-requests' },
];

const ANALYTICS_GROUP: HelpTopic[] = [
  { title: 'Reports', description: 'Fleet uptime and soft-inactive reporting (rolling out with the reporting endpoints).', to: '/' },
  { title: 'Device Detail', description: 'Per-device downtime trend and deal-type context.', to: '/' },
  { title: 'Root-Cause Analytics', description: 'Distribution of root causes across resolved tickets.', to: '/' },
  { title: 'System Efficiency', description: 'Auto-dispatch efficiency and end-to-end cycle metrics.', to: '/' },
];

const ADMIN_GROUP: HelpTopic[] = [
  { title: 'Coverage', description: 'Configure Floating-SE territory as a union of State / Region / District.', to: '/coverage' },
  { title: 'CSM Backup Share', description: 'Per-zone share of acted-as-backup actions this month.', to: '/reports/csm-approval-share' },
  { title: 'Settings', description: 'SLA rules, access matrix, and organisation configuration.', to: '/settings' },
  { title: 'Help Center', description: 'This page — role-scoped guidance and the terminology glossary.', to: '/help' },
];

/** Build the role-scoped topic groups, mirroring the nav's role logic. */
export function buildHelpSections(role: string): HelpGroup[] {
  const label = ROLE_LABEL[role] ?? role;

  if (role === 'WAREHOUSE_MANAGER') {
    return [{ heading: `Your module — ${label}`, topics: WAREHOUSE_MODULE }];
  }

  const isManager =
    role === 'ZONAL_MANAGER' || role === 'CENTRAL_SERVICE_MANAGER' || role === 'OPERATIONS_HEAD';
  const isOpsHead = role === 'OPERATIONS_HEAD';

  const groups: HelpGroup[] = [{ heading: `Your module — ${label}`, topics: MANAGER_MODULE }];
  if (isManager) {
    groups.push({ heading: 'Components & Warehouse', topics: COMPONENTS_GROUP });
    groups.push({ heading: 'Analytics', topics: ANALYTICS_GROUP });
  }
  if (isOpsHead) {
    groups.push({ heading: 'Admin', topics: ADMIN_GROUP });
  }
  return groups;
}

interface GlossaryEntry {
  term: string;
  definition: string;
}

const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Readiness blocks only on ON_TRIP',
    definition:
      'A vehicle/device only fails readiness when its state is ON_TRIP; other states never block dispatch.',
  },
  {
    term: 'Activity ping never gates scoring',
    definition:
      'last_activity_at staleness is informational only — it is never a hard filter in SE recommendation.',
  },
  {
    term: 'Two transactional SLA pauses',
    definition:
      'SLA can pause for awaiting-components and awaiting-customer; both are transactional and audited.',
  },
  {
    term: 'Derived SE activity states',
    definition:
      'Activity status is derived from schedule + verification signals, not set manually by the engineer.',
  },
  {
    term: 'Common Kit is global',
    definition:
      'Common Kit is shared global state; an SE with no van-stock rows is treated as kit-complete.',
  },
  {
    term: 'Analytics from summary tables',
    definition:
      'Reports read from pre-aggregated summary tables, so figures may trail live operational data slightly.',
  },
];

function HelpTopicGrid({ topics }: { topics: HelpTopic[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {topics.map((t) => (
        <Card key={t.title} className="flex flex-col p-4">
          <h4 className="text-sm font-semibold text-ink-strong">{t.title}</h4>
          <p className="mt-1 flex-1 text-xs text-ink-muted">{t.description}</p>
          <Link
            to={t.to}
            className="mt-3 text-xs font-medium text-brand-700 hover:text-brand-600"
          >
            View Docs →
          </Link>
        </Card>
      ))}
    </div>
  );
}

function GlossaryCard({ entry }: { entry: GlossaryEntry }) {
  return (
    <Card className="p-4">
      <h4 className="text-sm font-semibold text-ink-strong">{entry.term}</h4>
      <p className="mt-1 text-xs text-ink-muted">{entry.definition}</p>
    </Card>
  );
}

export function HelpCenterPage() {
  const { session } = useAuth();
  const role = session?.role ?? '';
  const sections = buildHelpSections(role);

  return (
    <section>
      <PageHeader
        title="Help Center"
        subtitle="Guidance and references scoped to your role. Each topic links out to the full docs; the glossary captures the model states and terminology that drive the platform."
      />

      <div className="flex flex-col gap-5">
        {sections.map((g) => (
          <SectionCard key={g.heading} title={g.heading}>
            <HelpTopicGrid topics={g.topics} />
          </SectionCard>
        ))}

        <SectionCard title="Model states & terminology">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {GLOSSARY.map((e) => (
              <GlossaryCard key={e.term} entry={e} />
            ))}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
