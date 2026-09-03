import { authHeaders } from './authHeaders';
// Typed client for the zone operating-mode read seam (`GET /api/dashboard/operating-mode`, Issue 136).
// Read-only legibility of the recommender's per-zone DEFICIT/PREVENTIVE signal. A ZM gets a single-row
// list (their own zone); OH/CSM get every zone (or one via `?zoneId=`). Mirrors the backend
// `ZoneOperatingMode`. The `mode` enum is the internal contract — the FE never renders it raw; the
// plain-language mapping lives in `utils/operatingModeCopy.ts`.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type OperatingMode = 'DEFICIT' | 'PREVENTIVE';

export interface ZoneOperatingMode {
  zoneId: string;
  zoneName: string;
  mode: OperatingMode;
  /** Eligible devices in the zone currently silent. */
  silentCount: number;
  /** Eligible devices in the zone (the denominator behind the switch). */
  eligibleCount: number;
}

export async function apiOperatingMode(zoneId?: number | string): Promise<ZoneOperatingMode[]> {
  const qs = zoneId !== undefined && zoneId !== '' ? `?zoneId=${zoneId}` : '';
  const res = await fetch(`${BASE_URL}/dashboard/operating-mode${qs}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as ZoneOperatingMode[];
}
