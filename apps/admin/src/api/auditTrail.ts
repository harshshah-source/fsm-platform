// Typed client for `/api/audit-trail` — the audit ledger search (#342) and the per-ticket action
// chain the drawer's Audit tab renders. Mirrors the backend `AuditTrailService`.
//
// Both reads go through `authHeaders()`, so the `X-Acting-As-Zone` header rides along: a CSM acting
// in a zone sees that zone's ledger, which is the same clamp the backend applies to its `ZONAL_MANAGER`
// scope. Nothing here re-implements the clamp — the server is the only place it lives.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** One ledger row: an `audit_logs` row with its actor and its zone resolved server-side. */
export interface AuditLedgerRow {
  /** `audit_logs.id` as a string — it is a bigint, and it is also the pagination cursor. */
  id: string;
  at: string;
  action: string;
  actorId: string;
  /** Null for the non-user actors the writers use (`SYSTEM`, `CUSTOMER`). */
  actorName: string | null;
  actorRole: string;
  actedAsRole: string | null;
  actingZoneId: number | null;
  /** Resolved zone: acting zone ▸ the ticket's zone ▸ the actor's home zone. Null = pan-India. */
  zoneId: number | null;
  zoneName: string | null;
  entityType: string;
  entityId: string;
  metadata: unknown;
}

export interface AuditSearchPage {
  rows: AuditLedgerRow[];
  /** Pass back as `cursor` for the next page; null when this is the last page. */
  nextCursor: string | null;
}

export interface AuditSearchFilters {
  actorUserId?: string;
  actedAsRole?: string;
  zoneId?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  /** ISO instants. The page sends day boundaries. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export async function apiAuditSearch(filters: AuditSearchFilters = {}): Promise<AuditSearchPage> {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  const qs = q.toString();
  const res = await fetch(`${BASE_URL}/audit-trail${qs ? `?${qs}` : ''}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as AuditSearchPage;
}

/** One entry in a Ticket's audit trail — a state transition or an audited action. */
export interface TicketAuditEntry {
  at: string;
  kind: 'STATE_CHANGE' | 'ACTION';
  actorId: string | null;
  actorRole: string | null;
  actedAsRole: string | null;
  fromState?: string | null;
  toState?: string;
  reasonCode?: string | null;
  action?: string;
  actingZone?: string | null;
  metadata?: unknown;
}

export interface TicketAuditTrail {
  ticketId: string;
  entries: TicketAuditEntry[];
}

export async function apiTicketAuditTrail(ticketId: string): Promise<TicketAuditTrail> {
  const res = await fetch(`${BASE_URL}/audit-trail/tickets/${ticketId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as TicketAuditTrail;
}

// ---- metadata rendering (#342 AC3) ----------------------------------------------------------
//
// `audit_logs.metadata` is free-form JSONB and the writers use several shapes for the same idea. The
// ledger and the drawer must not each guess differently, so the from/to reading lives here, once,
// with the shapes that are actually in `src/` today:
//
//   { previous, next }                       — the canonical pair (settings, #343)
//   { previousHours, newHours }              — prefixed pairs, one per field
//   { dealType, previous }                   — a bare `previous` beside the single new value
//   { from, to } / { before, after } / { old, new }
//
// Anything that matches none of them renders as plain key/value detail rather than being dropped.

export interface MetadataChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Keys that describe the action rather than name a changed field. */
const REASON_KEYS = ['reason', 'reasonCode', 'overrideReason', 'notes'];
const DESCRIPTIVE_KEYS = new Set([...REASON_KEYS, 'key', 'field', 'timeZone', 'at']);

const PAIRS: Array<[string, string]> = [
  ['previous', 'next'],
  ['previous', 'new'],
  ['from', 'to'],
  ['before', 'after'],
  ['old', 'new'],
];
const OLD_PREFIXES = ['previous', 'prev', 'old'];
const NEW_PREFIXES = ['new', 'next'];

const lowerFirst = (s: string) => (s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s);
const asRecord = (metadata: unknown): Record<string, unknown> | null =>
  typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

/**
 * The from/to changes a metadata blob describes, in the order a reader would say them. Returns an
 * empty array when the blob records no transition — the caller then shows the raw detail instead.
 */
export function metadataChanges(metadata: unknown): MetadataChange[] {
  const m = asRecord(metadata);
  if (!m) return [];
  const changes: MetadataChange[] = [];
  const consumed = new Set<string>();

  // 1. Prefixed pairs — `previousHours` / `newHours`, which name their own field.
  for (const key of Object.keys(m)) {
    const oldPrefix = OLD_PREFIXES.find((p) => key.startsWith(p) && key.length > p.length);
    if (!oldPrefix) continue;
    const suffix = key.slice(oldPrefix.length);
    const newKey = NEW_PREFIXES.map((p) => p + suffix).find((k) => k in m);
    if (!newKey) continue;
    changes.push({ field: lowerFirst(suffix), from: m[key], to: m[newKey] });
    consumed.add(key);
    consumed.add(newKey);
  }

  // 2. Exact pairs — the field name comes from `key`/`field` when the writer supplied one.
  for (const [oldKey, newKey] of PAIRS) {
    if (consumed.has(oldKey) || consumed.has(newKey)) continue;
    if (!(oldKey in m) || !(newKey in m)) continue;
    const named = typeof m.key === 'string' ? m.key : typeof m.field === 'string' ? m.field : null;
    changes.push({ field: named ?? 'value', from: m[oldKey], to: m[newKey] });
    consumed.add(oldKey);
    consumed.add(newKey);
  }

  // 3. A bare `previous`/`old`/`before` beside exactly one other value — `{ dealType, previous }`.
  if (changes.length === 0) {
    const bare = ['previous', 'old', 'before'].find((k) => k in m);
    if (bare) {
      const rest = Object.keys(m).filter((k) => k !== bare && !DESCRIPTIVE_KEYS.has(k));
      if (rest.length === 1) changes.push({ field: rest[0], from: m[bare], to: m[rest[0]] });
    }
  }

  return changes;
}

/** The operator-supplied justification on a row, when the writer recorded one. */
export function metadataReason(metadata: unknown): string | null {
  const m = asRecord(metadata);
  if (!m) return null;
  for (const key of REASON_KEYS) {
    const value = m[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** Everything the from/to and reason readings did not already say, as `key=value` detail. */
export function metadataDetail(metadata: unknown): string | null {
  const m = asRecord(metadata);
  if (!m) return metadata === null || metadata === undefined ? null : String(metadata);
  const spoken = new Set<string>(REASON_KEYS);
  for (const change of metadataChanges(m)) {
    for (const key of Object.keys(m)) {
      const value = m[key];
      if (value === change.from || value === change.to || key === change.field) spoken.add(key);
    }
    spoken.add('key');
    spoken.add('field');
  }
  const rest = Object.keys(m).filter((k) => !spoken.has(k));
  if (rest.length === 0) return null;
  return rest.map((k) => `${k}: ${format(m[k])}`).join(' · ');
}

/** Render one metadata value for display — `null` and objects included. */
export function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
