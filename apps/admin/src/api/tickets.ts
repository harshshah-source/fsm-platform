// Typed client for the ticket read surface (Issue 05 `/api/tickets`). Used by the dashboard's
// company → plant → device drill-down to load a plant's devices.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export interface TicketRow {
  ticketId: string;
  workType: string;
  status: string;
  deviceId: string;
  plantId: string;
  /** Plant display name (may be an AutoPlant short code — format with `formatPlantDisplayName`). */
  plantName?: string | null;
  companyId: string;
  companyName?: string | null;
  /** Vehicle registration number — the operator-facing vehicle identity. */
  vehicleNo?: string | null;
  /** Transporter operating the vehicle (per-vehicle-per-ticket); null when unlinked or not yet mirrored. */
  transporterName?: string | null;
  companyTier: string;
  assignmentState: string;
  /** The SE holding the ticket's active day-plan batch (null while UNASSIGNED). */
  assignedSeId?: string | null;
  assignedSeName?: string | null;
  batchId?: string | null;
  scheduleId?: string | null;
  /** Dispatch run behind the batch's schedule — with `batchId`, links to the batch-assignment page.
   * Null when the schedule predates the dispatch ledger. */
  runId?: string | null;
  /** True when the assignment was ZM-overridden (batch or schedule OVERRIDDEN). */
  overridden?: boolean;
  slaBucket: string | null;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. Null if never seen. */
  latestGpsDatetime: string | null;
  repeatFailure: boolean;
  failureCycleState: string | null;
  /** Issue 23 — latest Component Request status + the SLA-pause timestamp for the WAITING_COMPONENT flag. */
  componentRequestStatus?: string | null;
  waitingComponentSince?: string | null;
  createdAt: string;
}

export interface TicketLifecycleEvent {
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorRole: string | null;
  actedAsRole: string | null;
  reasonCode: string | null;
  at: string;
}

export interface TicketDetail extends TicketRow {
  vehicleId: string | null;
  failureCycleId: string | null;
  lastStateChangedAt: string;
  lifecycle: TicketLifecycleEvent[];
}

export interface TicketFilters {
  workType?: string;
  status?: string;
  companyId?: string;
  plantId?: string;
  /** Free-text plant lookup — matches the plant name (partial) or a numeric plant id. */
  plant?: string;
  /** Universal search: device id, vehicle number, plant/company name or id. */
  q?: string;
  assignmentState?: string;
  bucket?: string;
}

async function get<T>(path: string): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export function apiTicketsList(filters: TicketFilters = {}): Promise<TicketRow[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  const qs = q.toString();
  return get<TicketRow[]>(`/tickets${qs ? `?${qs}` : ''}`);
}

export const apiTicketDetail = (id: string) =>
  get<TicketDetail>(`/tickets/${encodeURIComponent(id)}`);

/** One persisted SE troubleshoot-form submission (Issue 70 read; FE-09 Forms tab). */
export interface TicketForm {
  submissionId: string;
  submissionType: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: string;
  rootCauseSubcategory: string | null;
  rootCauseNotes: string | null;
  actionTakenCategory: string | null;
  actionTakenNotes: string | null;
  diagnosisNotes: string | null;
  componentUnavailable: boolean;
  componentUnavailableItem: string | null;
  photoRefs: string[];
  presenceSource: string;
  seGpsLat: number | null;
  seGpsLon: number | null;
  submittedAt: string;
}

export const apiTicketForms = (id: string) =>
  get<{ ticketId: string; forms: TicketForm[] }>(`/tickets/${encodeURIComponent(id)}/forms`);

export const apiTicketsByPlant = (plantId: string) => apiTicketsList({ plantId });
