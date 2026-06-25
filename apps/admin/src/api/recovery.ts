// Typed client for the Recovery Ticket field workflow (Issue 36, `/api/recovery`). The Warehouse
// Manager's "Awaiting Receipt" queue lists COLLECTED recovery tickets and confirms physical receipt
// (auto-close). Uses the shared authHeaders so acting attribution flows where applicable.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface RecoveryRow {
  ticketId: string;
  status: string;
  deviceId: string;
  assignedSeId: string | null;
  collectedDeviceSerial: string | null;
  collectionConditionNotes: string | null;
  unableToCollectReason: string | null;
  closureType: string | null;
  closedAt: string | null;
}

export async function apiRecoveryAwaitingReceipt(): Promise<RecoveryRow[]> {
  const res = await fetch(`${BASE_URL}/recovery/awaiting-receipt`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as RecoveryRow[];
}

export async function apiConfirmRecoveryReceipt(ticketId: string): Promise<RecoveryRow> {
  return post(`/recovery/${ticketId}/receipt`);
}

export async function apiRecoveryZmQueue(): Promise<RecoveryRow[]> {
  const res = await fetch(`${BASE_URL}/recovery/zm-queue`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as RecoveryRow[];
}

export async function apiRescheduleRecovery(ticketId: string, seId: string): Promise<RecoveryRow> {
  return post(`/recovery/${ticketId}/reschedule`, { seId });
}

export async function apiCloseFailedRecovery(ticketId: string, reason: string): Promise<RecoveryRow> {
  return post(`/recovery/${ticketId}/close-failed`, { reason });
}

export async function apiEscalateRecovery(ticketId: string): Promise<RecoveryRow> {
  return post(`/recovery/${ticketId}/escalate`);
}

export async function apiManualCloseRecovery(ticketId: string, reason: string): Promise<RecoveryRow> {
  return post(`/recovery/${ticketId}/manual-close`, { reason });
}

async function post(path: string, body?: unknown): Promise<RecoveryRow> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as RecoveryRow;
}
