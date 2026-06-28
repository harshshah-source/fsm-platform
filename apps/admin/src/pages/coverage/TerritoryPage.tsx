import { useEffect, useMemo, useState } from 'react';
import {
  type DistrictView,
  type EngineerView,
  type RegionView,
  type TerritoryRow,
  apiAddTerritory,
  apiFloatingEngineers,
  apiGeoDistricts,
  apiGeoRegions,
  apiGeoStates,
  apiListTerritory,
  apiRemoveTerritory,
} from '../../api/territory';
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  type Column,
} from '../../components/data';
import { Button, Field, SectionCard } from '../../components/ui';

/**
 * Floating-SE Territory config (Issue 09, ADR-0006). Operations Head picks a FLOATING SE, then builds
 * their Territory as a union of hierarchical State / Region / District selections; each "Add" creates
 * one membership row. The map-drawing (polygon) editor is deferred for v1 — shown disabled so the
 * reserved capability is visible. The plant_eligible_floating_se MV refreshes on each edit (backend).
 *
 * FE-19 reskin: presentation only. Native selects are retained (labelled via `Field`) so the locked
 * selector contract holds; the membership list now renders through the canonical `DataTable`.
 */
export function TerritoryPage() {
  const [engineers, setEngineers] = useState<EngineerView[]>([]);
  const [seId, setSeId] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const [regions, setRegions] = useState<RegionView[]>([]);
  const [districts, setDistricts] = useState<DistrictView[]>([]);
  const [state, setState] = useState('');
  const [regionId, setRegionId] = useState('');
  const [districtId, setDistrictId] = useState('');
  const [territory, setTerritory] = useState<TerritoryRow[]>([]);

  useEffect(() => {
    void apiFloatingEngineers().then(setEngineers);
    void apiGeoStates().then(setStates);
  }, []);

  useEffect(() => {
    if (!seId) {
      setTerritory([]);
      return;
    }
    void apiListTerritory(seId).then(setTerritory);
  }, [seId]);

  useEffect(() => {
    if (!state) {
      setRegions([]);
      setDistricts([]);
      return;
    }
    void apiGeoRegions(state).then(setRegions);
    void apiGeoDistricts(state).then(setDistricts);
    setRegionId('');
    setDistrictId('');
  }, [state]);

  useEffect(() => {
    if (!state) return;
    void apiGeoDistricts(state, regionId ? Number(regionId) : undefined).then(setDistricts);
    setDistrictId('');
  }, [regionId, state]);

  const districtName = useMemo(() => new Map(districts.map((d) => [d.districtId, d.name])), [districts]);
  const regionName = useMemo(() => new Map(regions.map((r) => [r.regionId, r.name])), [regions]);

  const refreshTerritory = async () => setTerritory(await apiListTerritory(seId));

  const canAdd = Boolean(seId) && (Boolean(districtId) || Boolean(regionId) || Boolean(state));

  const add = async () => {
    if (!canAdd) return;
    // Add at the most specific selected level (district > region > state).
    if (districtId) await apiAddTerritory({ seId, districtId: Number(districtId) });
    else if (regionId) await apiAddTerritory({ seId, regionId: Number(regionId) });
    else await apiAddTerritory({ seId, state });
    // Keep the State selected (its districts/regions stay loaded so the territory list can label
    // rows by name); just clear the finer selections.
    setRegionId('');
    setDistrictId('');
    await refreshTerritory();
  };

  const remove = async (id: number) => {
    await apiRemoveTerritory(id);
    await refreshTerritory();
  };

  const describe = (row: TerritoryRow): string => {
    if (row.districtId !== null) return `District: ${districtName.get(row.districtId) ?? row.districtId}`;
    if (row.regionId !== null) return `Region: ${regionName.get(row.regionId) ?? row.regionId}`;
    return `State: ${row.state}`;
  };

  const territoryColumns: Column<TerritoryRow>[] = [
    { key: 'coverage', header: 'Coverage', render: (row) => describe(row) },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="secondary" onClick={() => void remove(row.id)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Floating-SE Territory"
        subtitle="Pick a Floating SE, then build their coverage as a union of State / Region / District memberships."
      />

      <div className="mb-6 max-w-sm">
        <Field label="Engineer" htmlFor="territory-engineer">
          <FilterSelect
            id="territory-engineer"
            className="w-full"
            value={seId}
            onChange={(e) => setSeId(e.target.value)}
          >
            <option value="">Select a Floating SE…</option>
            {engineers.map((e) => (
              <option key={e.engineerId} value={e.engineerId}>
                {e.engineerId}
              </option>
            ))}
          </FilterSelect>
        </Field>
      </div>

      {seId && (
        <div className="grid max-w-4xl gap-6 md:grid-cols-2">
          <SectionCard title="Current territory">
            <DataTable
              columns={territoryColumns}
              rows={territory}
              rowKey={(row) => String(row.id)}
              ariaLabel="Current territory"
              empty={<EmptyState message="No territory yet — add State / Region / District." />}
            />
          </SectionCard>

          <SectionCard title="Add coverage">
            <div className="flex flex-col gap-3">
              <Field label="State" htmlFor="territory-state">
                <FilterSelect
                  id="territory-state"
                  className="w-full"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">Select state…</option>
                  {states.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </FilterSelect>
              </Field>

              <Field label="Region" htmlFor="territory-region">
                <FilterSelect
                  id="territory-region"
                  className="w-full"
                  value={regionId}
                  onChange={(e) => setRegionId(e.target.value)}
                  disabled={!state}
                >
                  <option value="">Whole state (no region)…</option>
                  {regions.map((r) => (
                    <option key={r.regionId} value={r.regionId}>
                      {r.name}
                    </option>
                  ))}
                </FilterSelect>
              </Field>

              <Field label="District" htmlFor="territory-district">
                <FilterSelect
                  id="territory-district"
                  className="w-full"
                  value={districtId}
                  onChange={(e) => setDistrictId(e.target.value)}
                  disabled={!state}
                >
                  <option value="">Whole region (no district)…</option>
                  {districts.map((d) => (
                    <option key={d.districtId} value={d.districtId}>
                      {d.name}
                    </option>
                  ))}
                </FilterSelect>
              </Field>

              <div className="mt-1 flex items-center gap-3">
                <Button type="button" onClick={() => void add()} disabled={!canAdd}>
                  Add to territory
                </Button>
                {/* AC#6 — the polygon map-drawing editor is reserved but deferred for v1. */}
                <Button
                  type="button"
                  variant="ghost"
                  disabled
                  title="Polygon drawing is coming in a later release"
                >
                  Draw polygon on map (coming soon)
                </Button>
              </div>
            </div>
          </SectionCard>
        </div>
      )}
    </section>
  );
}
