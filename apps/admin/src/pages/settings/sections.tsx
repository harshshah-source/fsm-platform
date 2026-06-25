import { useEffect, useState, type ReactNode } from 'react';
import * as org from '../../api/org';

/** Loads a list once on mount and exposes the items + an error string + a setter for optimistic
 * appends. Kept deliberately small — each config section owns its own create form. */
function useList<T>(fetcher: () => Promise<T[]>): {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  error: string | null;
} {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetcher()
      .then((rows) => live && setItems(rows))
      .catch(() => live && setError('Failed to load'));
    return () => {
      live = false;
    };
    // fetcher identity is stable (module function); intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { items, setItems, error };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-600">{label}</span>
      {children}
    </label>
  );
}

const inputClass = 'rounded border px-2 py-1';
const btnClass = 'rounded bg-slate-800 px-3 py-1 text-sm text-white';

export function ZonesSection() {
  const { items, setItems } = useList(org.listZones);
  const [name, setName] = useState('');
  return (
    <section>
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await org.createZone(name);
          setItems((xs) => [...xs, created]);
          setName('');
        }}
      >
        <Field label="Zone name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button className={btnClass} type="submit">
          Add zone
        </button>
      </form>
      <ul className="text-sm">
        {items.map((z) => (
          <li key={z.zoneId}>{z.name}</li>
        ))}
      </ul>
    </section>
  );
}

export function PlantsSection() {
  const { items, setItems } = useList(org.listPlants);
  const { items: zones } = useList(org.listZones);
  const [name, setName] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <section>
      <form
        className="mb-4 flex items-end gap-2"
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
      >
        <Field label="Plant name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Zone">
          <select className={inputClass} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">Select zone…</option>
            {zones.map((z) => (
              <option key={z.zoneId} value={z.zoneId}>
                {z.name}
              </option>
            ))}
          </select>
        </Field>
        <button className={btnClass} type="submit">
          Add plant
        </button>
      </form>
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <table className="text-sm">
        <tbody>
          {items.map((p) => (
            <tr key={p.plantId}>
              <td className="pr-4">{p.name}</td>
              <td className="text-slate-500">zone {p.zoneId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function CompaniesSection() {
  const { items, setItems } = useList(org.listCompanies);
  const [name, setName] = useState('');
  const [companyTier, setTier] = useState('PLATINUM');
  const [companyPriorityRank, setRank] = useState('A');
  return (
    <section>
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await org.createCompany({ name, companyTier, companyPriorityRank });
          setItems((xs) => [...xs, created]);
          setName('');
        }}
      >
        <Field label="Company name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Tier">
          <select className={inputClass} value={companyTier} onChange={(e) => setTier(e.target.value)}>
            <option value="PLATINUM">PLATINUM</option>
            <option value="GOLD">GOLD</option>
            <option value="SILVER">SILVER</option>
          </select>
        </Field>
        <Field label="Rank">
          <input className={inputClass} value={companyPriorityRank} onChange={(e) => setRank(e.target.value)} />
        </Field>
        <button className={btnClass} type="submit">
          Add company
        </button>
      </form>
      <table className="text-sm">
        <tbody>
          {items.map((c) => (
            <CompanyRow
              key={c.companyId}
              company={c}
              onSaved={(updated) => setItems((xs) => xs.map((x) => (x.companyId === updated.companyId ? updated : x)))}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A Companies table row with inline Operations-Head edit of tier / rank / ops-override (Issue 46). */
function CompanyRow({ company, onSaved }: { company: org.CompanyView; onSaved: (c: org.CompanyView) => void }) {
  const [editing, setEditing] = useState(false);
  const [tier, setTier] = useState(company.companyTier);
  const [rank, setRank] = useState(company.companyPriorityRank);
  const [override, setOverride] = useState(company.opsOverride);

  if (!editing) {
    return (
      <tr>
        <td className="pr-4">{company.name}</td>
        <td className="pr-4">{company.companyTier}</td>
        <td className="pr-4">{company.companyPriorityRank}</td>
        <td className="pr-4 text-slate-500">{company.opsOverride ? 'override' : ''}</td>
        <td>
          <button type="button" className="rounded border px-2 py-0.5 text-xs" onClick={() => setEditing(true)}>
            Edit
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="pr-4">{company.name}</td>
      <td className="pr-4">
        <select
          aria-label={`Tier for ${company.name}`}
          className={inputClass}
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          <option value="PLATINUM">PLATINUM</option>
          <option value="GOLD">GOLD</option>
          <option value="SILVER">SILVER</option>
        </select>
      </td>
      <td className="pr-4">
        <input aria-label={`Rank for ${company.name}`} className={inputClass} value={rank} onChange={(e) => setRank(e.target.value)} />
      </td>
      <td className="pr-4">
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            aria-label={`Ops override for ${company.name}`}
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          override
        </label>
      </td>
      <td className="flex gap-1">
        <button
          type="button"
          className="rounded bg-slate-800 px-2 py-0.5 text-xs text-white"
          onClick={async () => {
            const updated = await org.updateCompany(company.companyId, {
              companyTier: tier,
              companyPriorityRank: rank,
              opsOverride: override,
            });
            onSaved(updated);
            setEditing(false);
          }}
        >
          Save
        </button>
        <button type="button" className="rounded border px-2 py-0.5 text-xs" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </td>
    </tr>
  );
}

export function UsersSection() {
  const { items, setItems } = useList(org.listUsers);
  const [name, setName] = useState('');
  const [role, setRole] = useState('ZONAL_MANAGER');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <section>
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await org.createUser({ name, role, email, phone });
          setItems((xs) => [...xs, created]);
          setName('');
          setEmail('');
          setPhone('');
        }}
      >
        <Field label="Full name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ZONAL_MANAGER">ZONAL_MANAGER</option>
            <option value="CENTRAL_SERVICE_MANAGER">CENTRAL_SERVICE_MANAGER</option>
            <option value="WAREHOUSE_MANAGER">WAREHOUSE_MANAGER</option>
            <option value="SERVICE_ENGINEER">SERVICE_ENGINEER</option>
            <option value="OPERATIONS_HEAD">OPERATIONS_HEAD</option>
          </select>
        </Field>
        <Field label="Email">
          <input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <button className={btnClass} type="submit">
          Add user
        </button>
      </form>
      <table className="text-sm">
        <tbody>
          {items.map((u) => (
            <tr key={u.userId}>
              <td className="pr-4">{u.name}</td>
              <td className="pr-4">{u.role}</td>
              <td>{u.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function SlaRulesSection() {
  const { items, setItems } = useList(org.listSlaRules);
  const [scope, setScope] = useState('company_tier');
  const [key, setKey] = useState('');
  const [submitWithinMinutes, setSubmit] = useState('');
  return (
    <section>
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
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
      >
        <Field label="Scope">
          <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="company_tier">company_tier</option>
            <option value="bucket">bucket</option>
          </select>
        </Field>
        <Field label="Key">
          <input className={inputClass} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Submit within (min)">
          <input
            className={inputClass}
            value={submitWithinMinutes}
            onChange={(e) => setSubmit(e.target.value)}
          />
        </Field>
        <button className={btnClass} type="submit">
          Save SLA rule
        </button>
      </form>
      <table className="text-sm">
        <tbody>
          {items.map((r) => (
            <tr key={`${r.scope}:${r.key}`}>
              <td className="pr-4">{r.scope}</td>
              <td className="pr-4">{r.key}</td>
              <td>{r.submitWithinMinutes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ScoringWeightsSection() {
  const { items, setItems } = useList(org.listScoringWeights);
  const [weightSetRef, setRef] = useState('v1');
  const [component, setComponent] = useState('');
  const [weight, setWeight] = useState('');
  return (
    <section>
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
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
      >
        <Field label="Weight set">
          <input className={inputClass} value={weightSetRef} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Component">
          <input className={inputClass} value={component} onChange={(e) => setComponent(e.target.value)} />
        </Field>
        <Field label="Weight">
          <input className={inputClass} value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <button className={btnClass} type="submit">
          Save weight
        </button>
      </form>
      <table className="text-sm">
        <tbody>
          {items.map((w) => (
            <tr key={`${w.weightSetRef}:${w.component}`}>
              <td className="pr-4">{w.weightSetRef}</td>
              <td className="pr-4">{w.component}</td>
              <td>{w.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Engineer profiles</h3>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
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
        >
          <Field label="SE user ID">
            <input className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <Field label="Coverage type">
            <select
              className={inputClass}
              value={coverageType}
              onChange={(e) => setCoverageType(e.target.value)}
            >
              <option value="DEDICATED">DEDICATED</option>
              <option value="MULTI_PLANT">MULTI_PLANT</option>
              <option value="FLOATING">FLOATING</option>
            </select>
          </Field>
          <Field label="Home zone ID">
            <input className={inputClass} value={zoneId} onChange={(e) => setZoneId(e.target.value)} />
          </Field>
          <Field label="Daily capacity">
            <input
              className={inputClass}
              value={dailyCapacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </Field>
          <button className={btnClass} type="submit">
            Add engineer
          </button>
        </form>
        <ul className="text-sm">
          {engineers.items.map((eng) => (
            <li key={eng.engineerId}>
              {eng.engineerId.slice(0, 8)} · {eng.coverageType} · zone {eng.zoneId}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Plant coverage (Dedicated / Multi-Plant)</h3>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
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
        >
          <Field label="SE ID">
            <input className={inputClass} value={covSeId} onChange={(e) => setCovSeId(e.target.value)} />
          </Field>
          <Field label="Plant">
            <select className={inputClass} value={covPlantId} onChange={(e) => setCovPlantId(e.target.value)}>
              <option value="">Select plant…</option>
              {plants.items.map((p) => (
                <option key={p.plantId} value={p.plantId}>
                  {p.name} (zone {p.zoneId})
                </option>
              ))}
            </select>
          </Field>
          <button className={btnClass} type="submit">
            Add coverage
          </button>
        </form>
        <ul className="text-sm">
          {coverage.items.map((c) => (
            <li key={c.id}>
              {c.seId.slice(0, 8)} → plant {c.plantId} ({c.coverageType})
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function CommonKitSection() {
  const { items, setItems } = useList(org.listCommonKit);
  const [componentId, setComponentId] = useState('');
  const [minQty, setMinQty] = useState('1');
  return (
    <section>
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const saved = await org.upsertCommonKit({
            componentId: Number(componentId),
            minQty: Number(minQty),
          });
          setItems((xs) => [...xs.filter((k) => k.componentId !== saved.componentId), saved]);
          setComponentId('');
        }}
      >
        <Field label="Component ID">
          <input className={inputClass} value={componentId} onChange={(e) => setComponentId(e.target.value)} />
        </Field>
        <Field label="Min qty">
          <input className={inputClass} value={minQty} onChange={(e) => setMinQty(e.target.value)} />
        </Field>
        <button className={btnClass} type="submit">
          Save kit item
        </button>
      </form>
      <table className="text-sm">
        <tbody>
          {items.map((k) => (
            <tr key={k.id}>
              <td className="pr-4">#{k.componentId}</td>
              <td>min {k.minQty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
