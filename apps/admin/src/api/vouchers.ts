// Typed client for Expense Vouchers (Issue 38, `/api/vouchers`). The ZM review queue + Approve /
// Reject / Needs-Clarification, and the Operations-Head Finance export + multi-select Mark PAID. Uses
// the shared authHeaders so CSM acting attribution flows on review actions.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type VoucherStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'ZONAL_MANAGER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'NEEDS_CLARIFICATION'
  | 'PAID';

export type ExpenseCategory = 'TRAVEL' | 'ACCOMMODATION' | 'PARTS' | 'TOOLS' | 'MEAL' | 'OTHER';

export interface VoucherItem {
  itemId: string;
  category: ExpenseCategory;
  amount: number;
  merchantVendorName: string | null;
  expenseDatetime: string | null;
  photoRef: string | null;
  limit: number;
  overLimit: boolean;
}

export interface VoucherActivityCheck {
  linkedTicketId: string | null;
  linkedPlantId: number | null;
  ticketFound: boolean;
  warning: string | null;
}

export interface VoucherRow {
  voucherId: string;
  seId: string;
  seName: string;
  zoneId: number;
  status: VoucherStatus;
  plantId: number | null;
  ticketId: string | null;
  vehicleId: number | null;
  totalAmount: number;
  submittedAt: string | null;
  reviewNotes: string | null;
  items: VoucherItem[];
  hasOverLimit: boolean;
  activityCheck: VoucherActivityCheck;
}

export type ReviewAction = 'APPROVE' | 'REJECT' | 'NEEDS_CLARIFICATION';

export async function apiVouchers(status: 'ZONAL_MANAGER_REVIEW' | 'APPROVED' = 'ZONAL_MANAGER_REVIEW'): Promise<VoucherRow[]> {
  const res = await fetch(`${BASE_URL}/vouchers?status=${status}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as VoucherRow[];
}

export async function apiReviewVoucher(voucherId: string, action: ReviewAction, notes?: string): Promise<{ status: VoucherStatus }> {
  return post(`/vouchers/${voucherId}/review`, { action, notes: notes ?? null });
}

export async function apiMarkVouchersPaid(
  voucherIds: string[],
  batchRef?: string,
): Promise<{ paid: string[]; skipped: { voucherId: string; status: string }[] }> {
  return post('/vouchers/mark-paid', { voucherIds, batchRef: batchRef ?? null });
}

/** Downloads the monthly Finance CSV of APPROVED vouchers. */
export async function apiExportVouchers(month: string): Promise<{ filename: string; csv: string }> {
  const res = await fetch(`${BASE_URL}/vouchers/export?month=${month}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return { filename: `vouchers-finance-${month}.csv`, csv: await res.text() };
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}
