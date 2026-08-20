// Typed client for the Assign Work Console's work pool (#273, decision #272 R1/R3).
//
// Uses the **shared** `authHeaders()`, not a local bearer-only copy like the older `api/schedules.ts`
// builder: it carries `X-Acting-As-Zone`, and the backend read honours it. Both halves have to land
// together or the change is invisible — a converted backend never sees the header from a client that
// does not send it (#239). On this surface that is not cosmetic: an Operations Head acting in a zone
// would otherwise open the console onto the pan-India pool and hand out another zone's work.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** One site's outstanding work, for one company. A plant serving several companies has several rows. */
export interface AssignablePlantRow {
  plantId: string;
  plantName: string;
  zoneId: string;
  /** Tickets a manual assign would move right now — the same set the commit writes. */
  openUnassigned: number;
  /** Devices at the site for this company: the denominator in `12 / 38`, not a work count. */
  totalDevices: number;
  criticalCount: number;
  /** Longest any assignable ticket's device has been silent, in hours; null when never computed. */
  oldestInactivityHours: number | null;
  /** Open and unassigned but held to a future date — deliberately excluded from `openUnassigned`. */
  heldCount: number;
}

export interface AssignableCompanyGroup {
  companyId: string;
  companyName: string;
  plants: AssignablePlantRow[];
}

export interface AssignableWorkView {
  date: string;
  totals: { openUnassigned: number; criticalCount: number; heldCount: number; plants: number };
  companies: AssignableCompanyGroup[];
}

export async function apiAssignableWork(): Promise<AssignableWorkView> {
  const res = await fetch(`${BASE_URL}/schedules/assignable-work`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as AssignableWorkView;
}
