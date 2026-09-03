import { authHeaders } from './authHeaders';
// Typed client for the Issue 33 Install-create backend (`/api/install`, `/api/install/upload`).
// Consumed by the Issue 69 admin surface. Unlike the generic `org.ts` helper, this client preserves
// the backend error `code` (and the CSV per-row `errors`) so the page can render them inline.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** Single-create body — ids are numeric strings (the backend parses them to BigInt). */
export interface CreateInstallBody {
  vehicleNo: string;
  plantId: string;
  companyId: string;
  deviceType?: string;
  deviceId: string;
  simId?: string;
  targetDate?: string;
  notes?: string;
}

/** JSON-safe created Install Ticket (mirrors backend `InstallTicketView`). */
export interface InstallTicketView {
  ticketId: string;
  workType: string;
  status: string;
  deviceId: string;
  vehicleId: string | null;
  plantId: string;
  companyId: string;
  installTriggerSource: string | null;
  createdBy: string | null;
  createdByRole: string | null;
  installBatchId: string | null;
}

/** One CSV row's failure, keyed by the 1-based line number in the uploaded content. */
export interface CsvRowError {
  line: number;
  code: string;
  field?: string;
}

export interface UploadCsvResult {
  created: string[];
  batchId: string;
}

/** Carries the backend error `code` (+ optional `field` / CSV `errors`) to the page. */
export class InstallApiError extends Error {
  code: string;
  field?: string;
  errors?: CsvRowError[];
  constructor(code: string, opts?: { field?: string; errors?: CsvRowError[] }) {
    super(code);
    this.name = 'InstallApiError';
    this.code = code;
    this.field = opts?.field;
    this.errors = opts?.errors;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload: { code?: string; field?: string; errors?: CsvRowError[] } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // non-JSON error body — fall through to a status-coded error
    }
    throw new InstallApiError(payload.code ?? `REQUEST_FAILED_${res.status}`, {
      field: payload.field,
      errors: payload.errors,
    });
  }
  return (await res.json()) as T;
}

export const createInstall = (body: CreateInstallBody) => post<InstallTicketView>('/install', body);
export const uploadInstallCsv = (csv: string) => post<UploadCsvResult>('/install/upload', { csv });
