import { useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  CommonKitSection,
  CompaniesSection,
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

// Operations-Head-owned configuration surfaces (Issue 02). Order mirrors the reference→rules flow.
const TABS: Tab[] = [
  { id: 'zones', label: 'Zones', render: () => <ZonesSection /> },
  { id: 'users', label: 'Users', render: () => <UsersSection /> },
  { id: 'companies', label: 'Companies', render: () => <CompaniesSection /> },
  { id: 'se-coverage', label: 'SE Coverage', render: () => <SeCoverageSection /> },
  { id: 'sla', label: 'SLA Rules', render: () => <SlaRulesSection /> },
  { id: 'weights', label: 'Scoring Weights', render: () => <ScoringWeightsSection /> },
  { id: 'kit', label: 'Common Kit', render: () => <CommonKitSection /> },
];

export function SettingsPage() {
  const { session, logout } = useAuth();
  const [active, setActive] = useState(TABS[0].id);
  const current = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div className="min-h-screen p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium">{session?.role}</span>
          <button type="button" onClick={logout} className="rounded border px-2 py-1">
            Log out
          </button>
        </div>
      </header>

      <div role="tablist" aria-label="Settings sections" className="mb-4 flex gap-2 border-b">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active}
            onClick={() => setActive(tab.id)}
            className={`px-3 py-2 text-sm ${
              tab.id === active ? 'border-b-2 border-slate-800 font-medium' : 'text-slate-500'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">{current.render()}</div>
    </div>
  );
}
