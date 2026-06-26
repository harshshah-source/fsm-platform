import { useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { DateRangeChips, PageHeader } from '../../components/data';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  AccessMatrixGrid,
  CommonKitSection,
  CompaniesSection,
  PlantsSection,
  ScoringWeightsSection,
  SeCoverageSection,
  SlaRulesSection,
  UsersSection,
  ZonesSection,
} from './sections';

interface Tab {
  id: string;
  label: string;
  render: () => ReactNode;
}

// Operations-Head-owned configuration surfaces (Issue 02 · FE-18, reference 26). Order mirrors the
// reference → rules flow; the Access matrix is the read-only role-visibility overview.
const TABS: Tab[] = [
  { id: 'zones', label: 'Zones', render: () => <ZonesSection /> },
  { id: 'plants', label: 'Plants', render: () => <PlantsSection /> },
  { id: 'users', label: 'Users', render: () => <UsersSection /> },
  { id: 'companies', label: 'Companies', render: () => <CompaniesSection /> },
  { id: 'se-coverage', label: 'SE Coverage', render: () => <SeCoverageSection /> },
  { id: 'sla', label: 'SLA Rules', render: () => <SlaRulesSection /> },
  { id: 'weights', label: 'Scoring Weights', render: () => <ScoringWeightsSection /> },
  { id: 'kit', label: 'Common Kit', render: () => <CommonKitSection /> },
  { id: 'access', label: 'Access', render: () => <AccessMatrixGrid /> },
];

/**
 * Settings (Issue 02 · FE-18 parity, reference 26). Operations-Head-only configuration console — zone /
 * plant / user / company / SE-coverage / SLA / scoring / kit CRUD plus a read-only role-access matrix.
 * Presentation-only refactor onto `PageHeader` + `DateRangeChips` + a token tab bar; the `Settings`
 * heading, the `role="tab"` set + labels, every form `aria-label`, and the `org.*` CRUD are preserved.
 * Route-level Operations-Head gating is unchanged (`AppRoutes`).
 */
export function SettingsPage() {
  const { session, logout } = useAuth();
  const [active, setActive] = useState(TABS[0].id);
  const current = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div className="min-h-screen p-6">
      <PageHeader
        title="Settings"
        subtitle="Operations-Head configuration console — zones, plants, users, companies, coverage, SLA, and scoring."
        actions={
          <>
            <DateRangeChips />
            {session?.role && <Badge tone="neutral">{session.role}</Badge>}
            <Button variant="secondary" size="sm" onClick={logout}>
              Log out
            </Button>
          </>
        }
      />

      <div role="tablist" aria-label="Settings sections" className="mb-5 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active}
            onClick={() => setActive(tab.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab.id === active
                ? 'border-brand-600 font-semibold text-ink-strong'
                : 'border-transparent text-ink-muted hover:text-ink-strong',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">{current.render()}</div>
    </div>
  );
}
