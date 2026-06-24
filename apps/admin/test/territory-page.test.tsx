import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerritoryPage } from '../src/pages/coverage/TerritoryPage';

/**
 * Issue 09 slice 6 — Floating-SE Territory config page. Operations Head picks a FLOATING SE and builds
 * their territory from the State / Region / District hierarchical selectors (union membership); the
 * polygon map-drawing editor is shown but deferred (AC#6).
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let territoryRows: Array<{ id: number; seId: string; districtId: number | null; regionId: number | null; state: string | null }>;
const fetchMock = vi.fn();

function stub() {
  territoryRows = [];
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u.includes('/org/engineers'))
      return json([
        { engineerId: 'se-float', coverageType: 'FLOATING', zoneId: 1, dailyCapacity: 6, isActive: true },
        { engineerId: 'se-ded', coverageType: 'DEDICATED', zoneId: 1, dailyCapacity: 8, isActive: true },
      ]);
    if (u.includes('/org/geo/states')) return json(['Maharashtra']);
    if (u.includes('/org/geo/regions')) return json([{ regionId: 10, name: 'Konkan', state: 'Maharashtra' }]);
    if (u.includes('/org/geo/districts'))
      return json([{ districtId: 100, name: 'Mumbai City', state: 'Maharashtra', regionId: 10 }]);
    if (u.includes('/org/se-territory') && method === 'POST') {
      const body = JSON.parse(String(opts?.body)) as { districtId?: number };
      territoryRows.push({ id: 1, seId: 'se-float', districtId: body.districtId ?? null, regionId: null, state: null });
      return json(territoryRows[territoryRows.length - 1]);
    }
    if (u.includes('/org/se-territory') && method === 'DELETE') {
      territoryRows = [];
      return json({});
    }
    if (u.includes('/org/se-territory')) return json(territoryRows);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Floating-SE Territory page (Issue 09 slice 6)', () => {
  it('lists only FLOATING SEs and shows the deferred polygon affordance', async () => {
    stub();
    render(<TerritoryPage />);

    const engineer = await screen.findByLabelText(/engineer/i);
    expect(within(engineer).getByRole('option', { name: 'se-float' })).toBeInTheDocument();
    expect(within(engineer).queryByRole('option', { name: 'se-ded' })).toBeNull();

    await userEvent.selectOptions(engineer, 'se-float');
    const polygon = screen.getByRole('button', { name: /polygon/i });
    expect(polygon).toBeDisabled();
  });

  it('adds a district to the territory via the hierarchical selectors', async () => {
    stub();
    render(<TerritoryPage />);

    await userEvent.selectOptions(await screen.findByLabelText(/engineer/i), 'se-float');
    await userEvent.selectOptions(await screen.findByLabelText(/^state$/i), 'Maharashtra');

    // Region + district options load asynchronously once the state is chosen.
    await screen.findByRole('option', { name: 'Konkan' });
    await userEvent.selectOptions(screen.getByLabelText(/^region$/i), '10');
    await screen.findByRole('option', { name: 'Mumbai City' });
    await userEvent.selectOptions(screen.getByLabelText(/^district$/i), '100');

    await userEvent.click(screen.getByRole('button', { name: /add to territory/i }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.some(
        ([url, opts]) =>
          String(url).includes('/org/se-territory') &&
          (opts as RequestInit | undefined)?.method === 'POST' &&
          String((opts as RequestInit).body).includes('"districtId":100'),
      );
      expect(posted).toBe(true);
    });

    const list = await screen.findByRole('list', { name: /current territory/i });
    expect(within(list).getByText(/Mumbai City/)).toBeInTheDocument();
  });
});
