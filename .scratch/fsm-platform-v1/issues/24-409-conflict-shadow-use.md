# 24 — 409 Conflict + Shadow Use + reconciliation + inventory rollback

Status: accepted (backend + admin Shadow Use Queue done; mobile 409 screen → 63)
Type: AFK
Progress: docs/progress/24-409-conflict-shadow-use.md — AC#1,#2,#4,#5,#6 done. Inventory ledger (migration 26); business 409 (TICKET_ALREADY_CLOSED) + Shadow Use; PRE_VERIFICATION→DEDUCTED/ROLLED_BACK on verification; Shadow Use Queue (reconcile/dispute→ZM). Mobile 409 screen → Issue 63 (blocked-by #54). 2026-06-24.

## What to build

The dual-SE conflict and inventory-reconciliation path. When an SE submits on a Ticket already closed by another SE, the server returns a business **409 Conflict** (distinct from an idempotency duplicate): components the rejected SE physically consumed are decremented from their Van Stock and recorded as a `SHADOW_USE` `inventory_transactions` row for Warehouse reconciliation. Mobile shows a full-screen 409 screen ("This Ticket was already closed by [SE] at [time]. Your consumed components have been logged as Shadow Use…") with View Van Stock / Go Back actions. **Shadow Use Queue** (`/warehouse/shadow-use`, Warehouse Manager): unreconciled SHADOW_USE rows; per-row **Mark Reconciled** or **Mark Disputed** (escalates to ZM with reason; Ticket gains an "Inventory Dispute" flag). Also handle inventory rollback when a Ticket fails GPS verification (device not actually installed/repaired) so Van Stock reflects physical reality (PRE_VERIFICATION → DEDUCTED lifecycle).

## Acceptance criteria

- [x] Second submit on a closed Ticket returns a business 409 (distinct from idempotency duplicate)
- [x] Consumed components decremented from Van Stock and logged as a SHADOW_USE inventory transaction
- [~] Mobile shows the full-screen 409 screen with correct copy and actions (backend payload ready; mobile UI → Issue 63)
- [x] Shadow Use Queue supports Mark Reconciled / Mark Disputed (dispute escalates to ZM, flags Ticket)
- [x] Failed-verification inventory rollback corrects Van Stock (PRE_VERIFICATION → DEDUCTED handled)
- [x] Two-SEs-same-Ticket reconciliation keeps both engineers' Van Stock accurate

## Blocked by

- #21
- #18
