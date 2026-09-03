import { useEffect, useState } from 'react';
import {
  getDispatchSchedule,
  putDispatchSchedule,
  type DispatchSchedule,
} from '../../api/dispatchSchedule';
import * as org from '../../api/org';
import { ROLE_LABEL } from '../../components/shell/nav';
import { Badge, Button, Input, Select } from '../../components/ui';
import { IconCheck } from '../../components/ui/icons';
import { BUCKET_CLASS, BUCKET_RANGE_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';
import { cn } from '../../lib/cn';
import {
  cellClass,
  cellRightClass,
  EntryForm,
  FactList,
  Field,
  Notice,
  Panel,
  PanelBand,
  rowClass,
  SettingsSection,
  SubHeading,
  TablePanel,
} from './primitives';
import type { Role } from '@fsm/shared';

/** Loads a list once on mount and exposes the items + an error string + a setter for optimistic
 * appends. Kept deliberately small — each config section owns its own create form. `loading` exists
 * only so a table can show its skeleton instead of flashing its empty state on every mount. */
function useList<T>(fetcher: () => Promise<T[]>): {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  error: string | null;
  loading: boolean;
} {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    fetcher()
      .then((rows) => live && setItems(rows))
      .catch(() => live && setError('Failed to load'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // fetcher identity is stable (module function); intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { items, setItems, error, loading };
}

/** The role a `SERVICE_ENGINEER`-style constant reads as on screen. Values sent to the API are the
 *  constants themselves — this only ever touches what an operator sees. */
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

const ROLE_OPTIONS = [
  'ZONAL_MANAGER',
  'CENTRAL_SERVICE_MANAGER',
  'WAREHOUSE_MANAGER',
  'SERVICE_ENGINEER',
  'OPERATIONS_HEAD',
] as const;

/** Short id column — a full uuid is never the thing an operator is reading a row for. */
function ShortId({ id }: { id: string }) {
  return (
    <span className="font-mono text-xs text-ink" title={id}>
      {id.slice(0, 8)}
    </span>
  );
}

/**
 * Quiet "12 zones" counter for a section header — orientation, not a metric. Renders nothing until
 * the list has actually arrived: "0 zones" beside a loading table is not a smaller truth, it is a
 * wrong one.
 */
function RecordCount({ count, noun, loading }: { count: number; noun: string; loading: boolean }) {
  if (loading) return null;
  return (
    <span className="text-xs tabular-nums text-ink-muted">
      {count} {count === 1 ? noun : `${noun}s`}
    </span>
  );
}

/**
 * Read-only colour-coded SLA bucket legend (FE-18, reference 26 "SLA bucket rules"). The bucket ramp is
 * the single colour source (`lib/slaBucket`); exact thresholds are configured in the SLA-rules CRUD below.
 *
 * Laid out as a left-to-right ramp rather than a stacked list: it *is* an ordinal scale, and reading it
 * along one axis says so in a way that eight rows each captioned "severity 5 / 8" cannot. The direction
 * is stated once, underneath, instead of once per band.
 */
export function SlaRulesTable() {
  // SLA_BUCKETS runs most-severe first; the ramp reads the other way, mildest on the left.
  const ascending = [...SLA_BUCKETS].reverse();
  return (
    <div>
      <SubHeading hint="How long a device has been silent, banded. The ramp is fixed — it is the vocabulary the rules below are written against.">
        Inactivity bands
      </SubHeading>
      <Panel>
        <div className="flex flex-wrap gap-2 p-4 sm:p-5">
          {ascending.map((b) => (
            <span
              key={b}
              className={cn(
                'inline-block min-w-24 rounded-full px-3 py-1 text-center text-xs font-semibold tabular-nums',
                BUCKET_CLASS[b],
              )}
            >
              {BUCKET_RANGE_LABEL[b]}
            </span>
          ))}
        </div>
        <PanelBand position="bottom">
          <p className="px-4 py-2.5 text-xs leading-5 text-ink-muted sm:px-5">
            Least severe on the left through to most severe on the right — eight fixed bands, lightest
            to darkest.
          </p>
        </PanelBand>
      </Panel>
    </div>
  );
}

const MATRIX_ROLES: Role[] = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD', 'WAREHOUSE_MANAGER', 'SERVICE_ENGINEER'];
const ROLE_SHORT: Record<Role, string> = {
  ZONAL_MANAGER: 'ZM',
  CENTRAL_SERVICE_MANAGER: 'CSM',
  OPERATIONS_HEAD: 'OH',
  WAREHOUSE_MANAGER: 'WM',
  SERVICE_ENGINEER: 'SE',
};
const ACCESS_FEATURES: { feature: string; roles: Role[] }[] = [
  { feature: 'Dashboard', roles: ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD', 'WAREHOUSE_MANAGER'] },
  { feature: 'Tickets', roles: ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
  { feature: 'Schedules / Planner', roles: ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
  { feature: 'Readiness / Recovery', roles: ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
  { feature: 'Component Requests', roles: ['WAREHOUSE_MANAGER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
  { feature: 'Shadow Use / Warehouse', roles: ['WAREHOUSE_MANAGER'] },
  { feature: 'Reports / Analytics', roles: ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
  { feature: 'Settings', roles: ['OPERATIONS_HEAD'] },
  // #238 — the one settings surface that is not OH-only. Listed separately from "Settings" precisely
  // because the matrix would otherwise say the CSM cannot reach any configuration, which is no longer
  // true; the OH's exclusive control over it is the lock, not the route.
  { feature: 'SE Assignment Threshold', roles: ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] },
];

/**
 * Read-only feature × role access matrix (FE-18, reference 26 "Role access matrix"). Mirrors the shell's
 * role-scoped navigation; a check means the role sees that surface, a dash means it is hidden.
 */
export function AccessMatrixGrid() {
  return (
    <SettingsSection
      title="Role access"
      description="Which roles reach which surface. This mirrors the navigation the shell builds for each role — it is a record of the access model, not a control."
      meta={<Badge tone="neutral">Read-only</Badge>}
    >
      <TablePanel
        ariaLabel="Role access matrix"
        headers={[
          { label: 'Feature' },
          ...MATRIX_ROLES.map((r) => ({ label: ROLE_SHORT[r], align: 'center' as const })),
        ]}
        rowCount={ACCESS_FEATURES.length}
        emptyMessage="No features listed."
      >
        {ACCESS_FEATURES.map((f) => (
          <tr key={f.feature} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{f.feature}</td>
            {MATRIX_ROLES.map((r) => (
              <td key={r} className={cn(cellClass, 'text-center')}>
                {f.roles.includes(r) ? (
                  <span className="inline-flex text-success">
                    <IconCheck className="h-4 w-4" />
                    <span className="sr-only">{`${f.feature} allowed for ${r}`}</span>
                  </span>
                ) : (
                  <span className="inline-flex text-ink-muted/40">
                    <span aria-hidden>–</span>
                    <span className="sr-only">{`${f.feature} hidden for ${r}`}</span>
                  </span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </TablePanel>
      <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <IconCheck aria-hidden className="h-3.5 w-3.5 text-success" /> visible
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="text-ink-muted/60">
            –
          </span>{' '}
          hidden
        </span>
        <span>{MATRIX_ROLES.map((r) => `${ROLE_SHORT[r]} ${roleLabel(r)}`).join(' · ')}</span>
      </p>
    </SettingsSection>
  );
}

export function ZonesSection() {
  const { items, setItems, error, loading } = useList(org.listZones);
  const [name, setName] = useState('');
  return (
    <SettingsSection
      title="Zones"
      description="The geographic operating units everything else hangs off — every plant, engineer and manager belongs to exactly one zone."
      meta={<RecordCount count={items.length} noun="zone" loading={loading} />}
    >
      {error && <Notice tone="critical">Failed to load zones.</Notice>}

      <TablePanel
        ariaLabel="Zones"
        headers={[{ label: 'Zone' }, { label: 'Zone ID', align: 'right' }]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No zones configured yet."
        emptyHint="Add the first zone above — plants, engineers and managers all need one to belong to."
        toolbar={
          <EntryForm
            legend="Add a zone"
            onSubmit={async (e) => {
              e.preventDefault();
              const created = await org.createZone(name);
              setItems((xs) => [...xs, created]);
              setName('');
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Add zone
              </Button>
            }
          >
            <Field label="Zone name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {items.map((z) => (
          <tr key={z.zoneId} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{z.name}</td>
            <td className={cellRightClass}>{z.zoneId}</td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

export function PlantsSection() {
  const { items, setItems, error: loadError, loading } = useList(org.listPlants);
  const { items: zones } = useList(org.listZones);
  const [name, setName] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Plants"
      description="Customer sites work is dispatched to. Each plant sits in one zone, which is what decides who manages it and which engineers can cover it."
      meta={<RecordCount count={items.length} noun="plant" loading={loading} />}
    >
      {error && <Notice tone="critical">{error}</Notice>}
      {!error && loadError && <Notice tone="critical">Failed to load plants.</Notice>}

      <TablePanel
        ariaLabel="Plants"
        headers={[{ label: 'Plant' }, { label: 'Zone' }]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No plants configured yet."
        emptyHint="A plant needs an existing zone — add one under Zones first if the list above is empty."
        toolbar={
          <EntryForm
            legend="Add a plant"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const created = await org.createPlant({ name, zoneId: Number(zoneId) });
                setItems((xs) => [...xs, created]);
                setName('');
              } catch {
                setError('Failed to create plant — check the zone exists.');
              }
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Add plant
              </Button>
            }
          >
            <Field label="Plant name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Zone">
              <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                <option value="">Select zone…</option>
                {zones.map((z) => (
                  <option key={z.zoneId} value={z.zoneId}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
          </EntryForm>
        }
      >
        {items.map((p) => (
          <tr key={p.plantId} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{p.name}</td>
            <td className={cn(cellClass, 'text-ink-muted')}>{p.zoneName ?? `Zone ${p.zoneId}`}</td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

export function CompaniesSection() {
  const { items, setItems, error, loading } = useList(org.listCompanies);
  const { items: tiers } = useList(org.listTiers);
  const [name, setName] = useState('');
  const [companyTier, setTier] = useState('PLATINUM');
  const [companyPriorityRank, setRank] = useState('A');
  return (
    <SettingsSection
      title="Companies"
      description="Customer accounts and their commercial classification. Tier and priority rank are what ticket prioritisation reads; the ops override flags an account operations handles by exception."
      meta={<RecordCount count={items.length} noun="company" loading={loading} />}
    >
      {error && <Notice tone="critical">Failed to load companies.</Notice>}

      <TablePanel
        ariaLabel="Companies"
        headers={[
          { label: 'Company' },
          { label: 'Tier' },
          { label: 'Rank' },
          { label: 'Ops override' },
          { label: <span className="sr-only">Actions</span>, align: 'right' },
        ]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No companies configured yet."
        toolbar={
          <EntryForm
            legend="Add a company"
            onSubmit={async (e) => {
              e.preventDefault();
              const created = await org.createCompany({ name, companyTier, companyPriorityRank });
              setItems((xs) => [...xs, created]);
              setName('');
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Add company
              </Button>
            }
          >
            <Field label="Company name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Tier" className="sm:w-40">
              <Select value={companyTier} onChange={(e) => setTier(e.target.value)}>
                {tiers.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rank" className="sm:w-28">
              <Input value={companyPriorityRank} onChange={(e) => setRank(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {items.map((c) => (
          <CompanyRow
            key={c.companyId}
            company={c}
            tiers={tiers}
            onSaved={(updated) => setItems((xs) => xs.map((x) => (x.companyId === updated.companyId ? updated : x)))}
          />
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

/** A Companies table row with inline Operations-Head edit of tier / rank / ops-override (Issue 46). */
function CompanyRow({
  company,
  tiers,
  onSaved,
}: {
  company: org.CompanyView;
  tiers: org.TierView[];
  onSaved: (c: org.CompanyView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState(company.companyTier);
  const [rank, setRank] = useState(company.companyPriorityRank);
  const [override, setOverride] = useState(company.opsOverride);

  if (!editing) {
    return (
      <tr className={rowClass}>
        <td className={cn(cellClass, 'font-medium text-ink-strong')}>{company.name}</td>
        <td className={cellClass}>
          <Badge tone="neutral">{company.companyTier}</Badge>
        </td>
        <td className={cn(cellClass, 'tabular-nums')}>{company.companyPriorityRank}</td>
        <td className={cellClass}>
          {company.opsOverride ? (
            <Badge tone="warning">Override</Badge>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        <td className={cn(cellClass, 'text-right')}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={cn(rowClass, 'bg-surface-raised')}>
      <td className={cn(cellClass, 'font-medium text-ink-strong')}>{company.name}</td>
      <td className={cellClass}>
        <Select
          aria-label={`Tier for ${company.name}`}
          className="h-9 w-36"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          {tiers.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </Select>
      </td>
      <td className={cellClass}>
        <Input
          aria-label={`Rank for ${company.name}`}
          className="h-9 w-20"
          value={rank}
          onChange={(e) => setRank(e.target.value)}
        />
      </td>
      <td className={cellClass}>
        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            aria-label={`Ops override for ${company.name}`}
            className="h-4 w-4 rounded border-line-strong focus-ring"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Override
        </label>
      </td>
      <td className={cn(cellClass, 'text-right')}>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const updated = await org.updateCompany(company.companyId, {
                  companyTier: tier,
                  companyPriorityRank: rank,
                  opsOverride: override,
                });
                onSaved(updated);
                setEditing(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function UsersSection() {
  const { items, setItems, error, loading } = useList(org.listUsers);
  const [name, setName] = useState('');
  const [role, setRole] = useState('ZONAL_MANAGER');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <SettingsSection
      title="Users"
      description="Console and mobile accounts. The role chosen here is the whole of what an account can see and do — it drives the navigation, the queues, and the approvals a user is offered."
      meta={<RecordCount count={items.length} noun="user" loading={loading} />}
    >
      {error && <Notice tone="critical">Failed to load users.</Notice>}

      <TablePanel
        ariaLabel="Users"
        headers={[
          { label: 'Name' },
          { label: 'Role' },
          { label: 'Email', hideBelow: 'md' },
          { label: 'Phone', hideBelow: 'md' },
          { label: 'Status', align: 'right' },
        ]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No users yet."
        emptyHint="What a role can reach is listed under Governance → Access."
        toolbar={
          <EntryForm
            legend="Add a user"
            onSubmit={async (e) => {
              e.preventDefault();
              const created = await org.createUser({ name, role, email, phone });
              setItems((xs) => [...xs, created]);
              setName('');
              setEmail('');
              setPhone('');
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Add user
              </Button>
            }
          >
            <Field label="Full name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {items.map((u) => (
          <tr key={u.userId} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{u.name}</td>
            <td className={cellClass}>{roleLabel(u.role)}</td>
            <td className={cn(cellClass, 'hidden text-ink-muted md:table-cell')}>{u.email || '—'}</td>
            <td className={cn(cellClass, 'hidden text-ink-muted md:table-cell')}>{u.phone || '—'}</td>
            <td className={cn(cellClass, 'text-right')}>
              <Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{u.status}</Badge>
            </td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

export function SlaRulesSection() {
  const { items, setItems, error, loading } = useList(org.listSlaRules);
  const [scope, setScope] = useState('company_tier');
  const [key, setKey] = useState('');
  const [submitWithinMinutes, setSubmit] = useState('');
  return (
    <SettingsSection
      title="SLA rules"
      description="The response clock. Bands below are the fixed vocabulary; a rule attaches a submit-within target to one company tier or one inactivity bucket."
    >
      <SlaRulesTable />

      <div>
        <SubHeading hint="Saving a scope + key that already exists replaces it.">
          Response thresholds
        </SubHeading>

        {error && <Notice tone="critical" className="mb-4">Failed to load SLA rules.</Notice>}

        <TablePanel
          ariaLabel="SLA rules"
          headers={[{ label: 'Scope' }, { label: 'Key' }, { label: 'Submit within (min)', align: 'right' }]}
          rowCount={items.length}
          loading={loading}
          emptyMessage="No SLA rules configured yet."
          emptyHint="Without a rule the platform falls back to its built-in default target."
          toolbar={
            <EntryForm
              legend="Add or update a rule"
              onSubmit={async (e) => {
                e.preventDefault();
                const saved = await org.upsertSlaRule({
                  scope,
                  key,
                  submitWithinMinutes: submitWithinMinutes ? Number(submitWithinMinutes) : undefined,
                });
                setItems((xs) => [...xs.filter((r) => !(r.scope === saved.scope && r.key === saved.key)), saved]);
                setKey('');
                setSubmit('');
              }}
              action={
                <Button className="w-full sm:w-auto" type="submit">
                  Save SLA rule
                </Button>
              }
            >
              <Field label="Scope" className="sm:w-44">
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="company_tier">company_tier</option>
                  <option value="bucket">bucket</option>
                </Select>
              </Field>
              <Field label="Key">
                <Input value={key} onChange={(e) => setKey(e.target.value)} />
              </Field>
              <Field label="Submit within (min)">
                <Input
                  inputMode="numeric"
                  value={submitWithinMinutes}
                  onChange={(e) => setSubmit(e.target.value)}
                />
              </Field>
            </EntryForm>
          }
        >
          {items.map((r) => (
            <tr key={`${r.scope}:${r.key}`} className={rowClass}>
              <td className={cn(cellClass, 'text-ink-muted')}>{r.scope}</td>
              <td className={cn(cellClass, 'font-medium text-ink-strong')}>{r.key}</td>
              <td className={cellRightClass}>{r.submitWithinMinutes ?? '—'}</td>
            </tr>
          ))}
        </TablePanel>
      </div>
    </SettingsSection>
  );
}

export function ScoringWeightsSection() {
  const { items, setItems, error, loading } = useList(org.listScoringWeights);
  const [weightSetRef, setRef] = useState('v1');
  const [component, setComponent] = useState('');
  const [weight, setWeight] = useState('');
  // #266 — the recommender's own vocabulary, fetched rather than restated. The field used to be free
  // text, so any string could be saved and would then sit in this table looking exactly like a real
  // lever while contributing nothing to a score. The server rejects those now; this makes the valid
  // set visible instead of leaving the operator to guess it from a 400.
  const [components, setComponents] = useState<string[]>([]);
  useEffect(() => {
    org
      .listScoringComponents()
      .then((r) => setComponents(r.components))
      .catch(() => setComponents([]));
  }, []);
  return (
    <SettingsSection
      title="Scoring weights"
      description="How the recommender ranks engineers for a ticket. Each component carries a weight inside a named weight set; saving an existing component in a set replaces its weight."
    >
      {error && <Notice tone="critical">Failed to load scoring weights.</Notice>}

      <TablePanel
        ariaLabel="Scoring weights"
        headers={[{ label: 'Weight set' }, { label: 'Component' }, { label: 'Weight', align: 'right' }]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No scoring weights configured yet."
        emptyHint="With no weights the recommender ranks on its built-in defaults."
        toolbar={
          <EntryForm
            legend="Add or update a weight"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await org.upsertScoringWeight({ weightSetRef, component, weight: Number(weight) });
              setItems((xs) => [
                ...xs.filter((w) => !(w.weightSetRef === saved.weightSetRef && w.component === saved.component)),
                saved,
              ]);
              setComponent('');
              setWeight('');
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Save weight
              </Button>
            }
          >
            <Field label="Weight set" className="sm:w-32">
              <Input value={weightSetRef} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <Field label="Component">
              <Select value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">Select component…</option>
                {components.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Weight" className="sm:w-28">
              <Input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {items.map((w) => (
          <tr key={`${w.weightSetRef}:${w.component}`} className={rowClass}>
            <td className={cn(cellClass, 'text-ink-muted')}>{w.weightSetRef}</td>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>{w.component}</td>
            <td className={cellRightClass}>{w.weight}</td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

export function SeCoverageSection() {
  const engineers = useList(org.listEngineers);
  const coverage = useList(org.listSeCoverage);
  const plants = useList(org.listPlants);
  const [userId, setUserId] = useState('');
  const [coverageType, setCoverageType] = useState('DEDICATED');
  const [zoneId, setZoneId] = useState('');
  const [dailyCapacity, setCapacity] = useState('8');
  const [covSeId, setCovSeId] = useState('');
  const [covPlantId, setCovPlantId] = useState('');

  const plantName = (plantId: number) =>
    plants.items.find((p) => p.plantId === plantId)?.name ?? `Plant ${plantId}`;

  return (
    <SettingsSection
      title="SE coverage"
      description="Who the engineers are and where each one works. The profile sets a home zone and a daily capacity; plant coverage names the specific sites a dedicated or multi-plant engineer is responsible for."
    >
      <div>
        <SubHeading hint="One profile per Service Engineer. Capacity is the number of visits a day the planner may schedule.">
          Engineer profiles
        </SubHeading>

        <TablePanel
          ariaLabel="Engineer profiles"
          headers={[
            { label: 'Engineer' },
            { label: 'Coverage' },
            { label: 'Home zone', align: 'right' },
            { label: 'Daily capacity', align: 'right' },
          ]}
          rowCount={engineers.items.length}
          loading={engineers.loading}
          emptyMessage="No engineer profiles yet."
          emptyHint="An engineer needs a user account with the Service Engineer role first."
          toolbar={
            <EntryForm
              legend="Add an engineer profile"
              onSubmit={async (e) => {
                e.preventDefault();
                const created = await org.createEngineer({
                  userId,
                  coverageType,
                  zoneId: Number(zoneId),
                  dailyCapacity: Number(dailyCapacity),
                });
                engineers.setItems((xs) => [...xs, created]);
                setUserId('');
              }}
              action={
                <Button className="w-full sm:w-auto" type="submit">
                  Add engineer
                </Button>
              }
            >
              <Field label="SE user ID">
                <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
              </Field>
              <Field label="Coverage type" className="sm:w-44">
                <Select value={coverageType} onChange={(e) => setCoverageType(e.target.value)}>
                  <option value="DEDICATED">DEDICATED</option>
                  <option value="MULTI_PLANT">MULTI_PLANT</option>
                  <option value="FLOATING">FLOATING</option>
                </Select>
              </Field>
              <Field label="Home zone ID" className="sm:w-36">
                <Input inputMode="numeric" value={zoneId} onChange={(e) => setZoneId(e.target.value)} />
              </Field>
              <Field label="Daily capacity" className="sm:w-36">
                <Input
                  inputMode="numeric"
                  value={dailyCapacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </Field>
            </EntryForm>
          }
        >
          {engineers.items.map((eng) => (
            <tr key={eng.engineerId} className={rowClass}>
              <td className={cellClass}>
                <ShortId id={eng.engineerId} />
              </td>
              <td className={cellClass}>{eng.coverageType}</td>
              <td className={cellRightClass}>{eng.zoneId}</td>
              <td className={cellRightClass}>{eng.dailyCapacity}</td>
            </tr>
          ))}
        </TablePanel>
      </div>

      <div className="border-t border-line pt-7">
        <SubHeading hint="Only dedicated and multi-plant engineers are pinned to plants — floating engineers are placed by territory instead.">
          Plant coverage
        </SubHeading>

        <TablePanel
          ariaLabel="Plant coverage"
          headers={[{ label: 'Engineer' }, { label: 'Plant' }, { label: 'Coverage' }]}
          rowCount={coverage.items.length}
          loading={coverage.loading}
          emptyMessage="No plant coverage recorded yet."
          toolbar={
            <EntryForm
              legend="Add plant coverage"
              onSubmit={async (e) => {
                e.preventDefault();
                const added = await org.addSeCoverage({
                  seId: covSeId,
                  plantId: Number(covPlantId),
                  coverageType,
                });
                coverage.setItems((xs) => [...xs, added]);
                setCovPlantId('');
              }}
              action={
                <Button className="w-full sm:w-auto" type="submit">
                  Add coverage
                </Button>
              }
            >
              <Field label="SE ID">
                <Input value={covSeId} onChange={(e) => setCovSeId(e.target.value)} />
              </Field>
              <Field label="Plant">
                <Select value={covPlantId} onChange={(e) => setCovPlantId(e.target.value)}>
                  <option value="">Select plant…</option>
                  {plants.items.map((p) => (
                    <option key={p.plantId} value={p.plantId}>
                      {p.name} (zone {p.zoneId})
                    </option>
                  ))}
                </Select>
              </Field>
            </EntryForm>
          }
        >
          {coverage.items.map((c) => (
            <tr key={c.id} className={rowClass}>
              <td className={cellClass}>
                <ShortId id={c.seId} />
              </td>
              <td className={cn(cellClass, 'font-medium text-ink-strong')}>{plantName(c.plantId)}</td>
              <td className={cn(cellClass, 'text-ink-muted')}>{c.coverageType}</td>
            </tr>
          ))}
        </TablePanel>
      </div>
    </SettingsSection>
  );
}

export function CommonKitSection() {
  const { items, setItems, error, loading } = useList(org.listCommonKit);
  const [componentId, setComponentId] = useState('');
  const [minQty, setMinQty] = useState('1');
  return (
    <SettingsSection
      title="Common kit"
      description="The components every engineer is expected to carry, and the minimum quantity of each. This is global — one kit definition for the whole field force."
      meta={<RecordCount count={items.length} noun="item" loading={loading} />}
    >
      {error && <Notice tone="critical">Failed to load the common kit.</Notice>}

      <TablePanel
        ariaLabel="Common kit"
        headers={[{ label: 'Component' }, { label: 'Minimum quantity', align: 'right' }]}
        rowCount={items.length}
        loading={loading}
        emptyMessage="No kit items defined yet."
        emptyHint="With an empty kit no engineer is ever flagged as under-stocked."
        toolbar={
          <EntryForm
            legend="Add or update a kit item"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await org.upsertCommonKit({
                componentId: Number(componentId),
                minQty: Number(minQty),
              });
              setItems((xs) => [...xs.filter((k) => k.componentId !== saved.componentId), saved]);
              setComponentId('');
            }}
            action={
              <Button className="w-full sm:w-auto" type="submit">
                Save kit item
              </Button>
            }
          >
            <Field label="Component ID" className="sm:w-40">
              <Input inputMode="numeric" value={componentId} onChange={(e) => setComponentId(e.target.value)} />
            </Field>
            <Field label="Min qty" className="sm:w-28">
              <Input inputMode="numeric" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
            </Field>
          </EntryForm>
        }
      >
        {items.map((k) => (
          <tr key={k.id} className={rowClass}>
            <td className={cn(cellClass, 'font-medium text-ink-strong')}>#{k.componentId}</td>
            <td className={cellRightClass}>{k.minQty}</td>
          </tr>
        ))}
      </TablePanel>
    </SettingsSection>
  );
}

/**
 * #213 — the daily dispatch run's schedule, Operations-Head-owned (CONTEXT.md Decisions §19).
 *
 * Two things this deliberately shows that a plain settings row would not: the **timezone** the
 * expression is interpreted in, and **when the job next fires**. The next-fire line is the operator's
 * confirmation that the change actually took — the failure this issue exists to prevent is a schedule
 * that reads as saved while dispatch keeps firing at the old hour, or does not fire at all.
 *
 * Control and consequence share one surface: the cron field on top, what is actually in force
 * underneath it. An invalid expression is rejected server-side with the cron parser's own reason, and
 * the schedule still in force stays on screen beneath the error, so there is never ambiguity about
 * what is running.
 */
export function DispatchScheduleSection() {
  const [schedule, setSchedule] = useState<DispatchSchedule | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getDispatchSchedule()
      .then((s) => {
        if (!live) return;
        setSchedule(s);
        setDraft(s.cron);
      })
      .catch(() => live && setError('Failed to load the dispatch schedule.'));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const outcome = await putDispatchSchedule(draft.trim());
      if (outcome.result === 'INVALID') {
        setError(outcome.reason);
        return;
      }
      setSchedule(outcome.schedule);
      setSaved(true);
    } catch {
      setError('Could not save the dispatch schedule.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Dispatch schedule"
      description="When the daily Recommender → Day-Plan dispatch run fires. A change takes effect immediately — no restart, no redeploy."
    >
      {error && <Notice tone="critical">{error}</Notice>}
      {saved && schedule && (
        <Notice tone="success" role="status" data-testid="dispatch-schedule-saved">
          Saved — the next run is scheduled for {new Date(schedule.nextFireAt).toLocaleString()}.
        </Notice>
      )}

      <Panel>
        <div className="p-4 sm:p-5">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-4">
            <Field label="Dispatch schedule (cron)" className="sm:w-64">
              <Input
                aria-label="Dispatch schedule (cron)"
                className="font-mono"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            <Button
              className="w-full sm:w-auto"
              type="button"
              onClick={save}
              disabled={busy}
              loading={busy}
              data-testid="dispatch-schedule-save"
            >
              Save schedule
            </Button>
          </div>
          {/* Under the row rather than under the field: a hint tucked inside the field's own stack
              drags the row's baseline down and leaves the button floating beside prose. */}
          <p className="mt-3 text-xs leading-5 text-ink-muted">
            Five fields — minute, hour, day of month, month, day of week.
          </p>
        </div>

        {schedule && (
          <PanelBand position="bottom">
            <div className="px-4 py-4 sm:px-5">
              <FactList
                items={[
                  {
                    term: 'In force',
                    value: (
                      <span className="font-mono" data-testid="dispatch-schedule-current">
                        {schedule.cron}
                      </span>
                    ),
                  },
                  {
                    term: 'Timezone',
                    value: <span data-testid="dispatch-schedule-timezone">{schedule.timeZone}</span>,
                  },
                  {
                    term: 'Next fire',
                    value: (
                      <span data-testid="dispatch-schedule-next">
                        {new Date(schedule.nextFireAt).toLocaleString()}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </PanelBand>
        )}
      </Panel>
    </SettingsSection>
  );
}
