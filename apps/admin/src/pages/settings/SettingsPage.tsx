import { Fragment, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { ROLE_LABEL } from '../../components/shell/nav';
import { Badge, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import { AssignmentThresholdSection } from './AssignmentThresholdSection';
import { ManagerAvailabilitySection } from './ManagerAvailabilitySection';
import {
  AccessMatrixGrid,
  CommonKitSection,
  CompaniesSection,
  DispatchScheduleSection,
  PlantsSection,
  ScoringWeightsSection,
  SeCoverageSection,
  SlaRulesSection,
  UsersSection,
  ZonesSection,
} from './sections';

interface Section {
  id: string;
  label: string;
  render: () => ReactNode;
}

interface SectionGroup {
  label: string;
  items: Section[];
}

/**
 * The information architecture, and the reason it is grouped rather than a flat strip.
 *
 * Eleven peer tabs across the top asked the operator to read every label before they could act, and
 * said nothing about what any of them meant to each other — "Zones" and "Scoring Weights" looked like
 * the same kind of thing. They are not. The console holds four genuinely different kinds of setting,
 * and the grouping is that distinction, not decoration:
 *
 *  - **Organisation** — records. Who and where: the zones, plants, companies and accounts the rest of
 *    the platform refers to. Changing one is a fact about the business.
 *  - **Field operations** — how silence turns into dispatched work. Coverage, the assignment
 *    threshold, and when the daily run fires. Changing one changes what the platform does tomorrow.
 *  - **Rules & policy** — the numbers the engine reads: response targets, recommender weights, the
 *    kit every engineer carries.
 *  - **Governance** — the read-only record of who can see what.
 *
 * Order inside a group runs most-referenced first. `Zones` stays the landing section because every
 * other record hangs off it.
 */
const GROUPS: SectionGroup[] = [
  {
    label: 'Organisation',
    items: [
      { id: 'zones', label: 'Zones', render: () => <ZonesSection /> },
      { id: 'plants', label: 'Plants', render: () => <PlantsSection /> },
      { id: 'companies', label: 'Companies', render: () => <CompaniesSection /> },
      { id: 'users', label: 'Users', render: () => <UsersSection /> },
    ],
  },
  {
    label: 'Field operations',
    items: [
      { id: 'se-coverage', label: 'SE Coverage', render: () => <SeCoverageSection /> },
      // #238 — the identical control is also routed at /assignment-threshold, which is how the CSM
      // (who co-owns it, and cannot open this OH-only console) reaches it.
      { id: 'assignment-threshold', label: 'Assignment Threshold', render: () => <AssignmentThresholdSection /> },
      // #213 — the daily dispatch time, moved out of an environment variable into this console.
      { id: 'dispatch', label: 'Dispatch Schedule', render: () => <DispatchScheduleSection /> },
      // #339 — who is covering a zone. Field operations rather than Governance: marking a manager
      // unavailable changes who may act tomorrow morning, which is an operating decision, not a
      // record of one. The CSM co-owns it and cannot open this console, so it is also routed at
      // /manager-availability — the same treatment the assignment threshold gets above.
      { id: 'manager-availability', label: 'Manager Availability', render: () => <ManagerAvailabilitySection /> },
    ],
  },
  {
    label: 'Rules & policy',
    items: [
      { id: 'sla', label: 'SLA Rules', render: () => <SlaRulesSection /> },
      { id: 'weights', label: 'Scoring Weights', render: () => <ScoringWeightsSection /> },
      { id: 'kit', label: 'Common Kit', render: () => <CommonKitSection /> },
    ],
  },
  {
    label: 'Governance',
    items: [{ id: 'access', label: 'Access', render: () => <AccessMatrixGrid /> }],
  },
];

/** Flat order — what the arrow keys walk, and what resolves the active panel. */
const SECTIONS: Section[] = GROUPS.flatMap((g) => g.items);

const tabId = (id: string) => `settings-tab-${id}`;
const panelId = (id: string) => `settings-panel-${id}`;

/**
 * Settings (Issue 02 · FE-18 parity, reference 26). Operations-Head-only configuration console — zone /
 * plant / user / company / SE-coverage / SLA / scoring / kit CRUD, the two dispatch policies, and a
 * read-only role-access matrix.
 *
 * Presentation only. Every section still renders the same component against the same `org.*` / policy
 * endpoints, the `role="tab"` set and its labels are unchanged, and route-level Operations-Head gating
 * still lives in `AppRoutes`. What the shape adds:
 *
 *  - a **grouped rail** instead of eleven equal tabs, with one heading and one sentence of purpose per
 *    section, arrow-key roving focus, and a proper tab/tabpanel relationship;
 *  - the open section lives in `?tab=` (the convention `FleetDirectoryPage` already uses), so a
 *    section is an address: reload keeps it, and "Settings → Dispatch Schedule" is a link you can send;
 *  - below `lg` the rail becomes a grouped `<select>` rather than a wrapping pile of eleven buttons —
 *    the same taxonomy, one control, no horizontal overflow.
 */
export function SettingsPage() {
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const railRef = useRef<HTMLDivElement>(null);

  // Unknown or absent `?tab=` resolves to the landing section rather than an error state — a stale
  // bookmark should open Settings, not break it.
  const requested = searchParams.get('tab');
  const active = SECTIONS.some((s) => s.id === requested) ? (requested as string) : SECTIONS[0].id;
  const current = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  const open = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    // `replace` — moving between sections of one page is not a navigation the Back button should have
    // to walk back out of one section at a time.
    setSearchParams(next, { replace: true });
  };

  /** Roving focus across the rail — the tab pattern's contract, in both orientations. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order = SECTIONS.map((s) => s.id);
    const i = order.indexOf(active);
    let next: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % order.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    if (next === null) return;
    e.preventDefault();
    open(order[next]);
    railRef.current?.querySelector<HTMLButtonElement>(`#${tabId(order[next])}`)?.focus();
  };

  return (
    <div>
      {/* The page's own header. Deliberately quiet — a title, one line of scope, and who is holding
          the keys. No filter chips: nothing on this page is filtered by a date range. */}
      <header className="mb-7 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-ink-strong">Settings</h2>
          <p className="mt-1.5 max-w-[72ch] text-sm leading-6 text-ink-muted">
            Workspace configuration owned by the Operations Head — the organisation records the platform
            refers to, the policies that turn device silence into dispatched work, and the rules the
            engine runs on.
          </p>
        </div>
        {session?.role && (
          <Badge tone="neutral">{ROLE_LABEL[session.role] ?? session.role}</Badge>
        )}
      </header>

      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
        <nav
          aria-label="Settings sections"
          className="mb-8 lg:mb-0 lg:sticky lg:top-[5.25rem] lg:self-start lg:border-r lg:border-line lg:pr-5"
        >
          {/* Narrow screens: the same taxonomy as one native control. Eleven buttons wrapping into
              four rows under four group labels cost more vertical space than the section they lead to. */}
          <div className="max-w-sm lg:hidden">
            <label
              htmlFor="settings-section-picker"
              className="mb-1.5 block text-xs font-semibold text-ink-muted"
            >
              Section
            </label>
            <Select
              id="settings-section-picker"
              value={active}
              onChange={(e) => open(e.target.value)}
            >
              {GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>

          <div
            ref={railRef}
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            className="hidden lg:flex lg:flex-col"
          >
            {GROUPS.map((group) => (
              <Fragment key={group.label}>
                {/* Not a tab — a label for the set beneath it. */}
                <div
                  role="presentation"
                  className="mt-6 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-caps first:mt-0"
                >
                  {group.label}
                </div>
                {group.items.map((section) => {
                  const isActive = section.id === active;
                  return (
                    <button
                      key={section.id}
                      id={tabId(section.id)}
                      role="tab"
                      type="button"
                      aria-selected={isActive}
                      aria-controls={panelId(section.id)}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => open(section.id)}
                      className={cn(
                        'relative w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-ring',
                        isActive
                          ? 'bg-surface-sunken font-semibold text-ink-strong'
                          : 'text-ink-muted hover:bg-luxury-100 hover:text-ink-strong',
                      )}
                    >
                      {isActive && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-brand-600"
                        />
                      )}
                      {section.label}
                    </button>
                  );
                })}
              </Fragment>
            ))}

            {/* There is no page-level Save bar, and its absence should be stated rather than
                discovered: every section here writes on its own action. */}
            <p className="mt-7 border-t border-line px-3 pt-4 text-xs leading-5 text-ink-muted">
              Each section saves on its own. Changes take effect immediately — no restart.
            </p>
          </div>
        </nav>

        <div
          role="tabpanel"
          id={panelId(current.id)}
          aria-labelledby={tabId(current.id)}
          tabIndex={0}
          className="min-w-0 focus-visible:outline-none"
        >
          {current.render()}
        </div>
      </div>
    </div>
  );
}
