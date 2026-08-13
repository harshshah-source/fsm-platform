import { describe, expect, it } from '@jest/globals';
import type { MeTicketRow } from '@fsm/shared';
import { computeHomeKpis } from './homeKpi';

function row(overrides: Partial<MeTicketRow>): MeTicketRow {
  return {
    ticketId: 't-1',
    ticketNo: 1,
    ticketNoDisplay: 'TCK-00001',
    assigned: true,
    workState: 'PLAN',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    plantId: 'p-1',
    plantName: 'Plant',
    companyName: 'Co',
    companyTier: 'GOLD',
    slaBucket: null,
    deviceId: 'd-1',
    vehicleId: null,
    vehicleNo: null,
    activeSoftState: null,
    createdAt: new Date('2026-08-04T00:00:00Z'),
    lastStateChangedAt: new Date('2026-08-04T00:00:00Z'),
    removedFromPlanAt: null,
    deferredToDate: null,
    topHint: null,
    ...overrides,
  };
}

describe('computeHomeKpis', () => {
  it('scopes to assigned tickets only — a shared-pool (unassigned) ticket never counts', () => {
    const kpis = computeHomeKpis([
      row({ assigned: false, workState: 'IN_WORK' }),
      row({ assigned: false, status: 'CLOSED' }),
    ]);

    expect(kpis).toEqual({ started: 0, completed: 0, verified: 0, failed: 0 });
  });

  it('STARTED counts workState IN_WORK', () => {
    const kpis = computeHomeKpis([row({ workState: 'IN_WORK' }), row({ workState: 'PLAN' })]);

    expect(kpis.started).toBe(1);
  });

  it('COMPLETED counts CLOSED only — never CLOSED_NON_OPERATIONAL, never CLOSED_AUTO_RECOVERY', () => {
    const kpis = computeHomeKpis([
      row({ status: 'CLOSED' }),
      // #229 D6 — a device that healed itself credits no SE effort (CONTEXT §Auto-Recovery). Counted
      // in this tile between 2026-08-04 and 2026-08-10; removed when the mechanism was wired and the
      // count stopped being hypothetical.
      row({ status: 'CLOSED_AUTO_RECOVERY' }),
      row({ status: 'CLOSED_NON_OPERATIONAL' }),
    ]);

    expect(kpis.completed).toBe(1);
  });

  it('VERIFIED counts only CLOSED TROUBLESHOOT tickets (the auto-verification pipeline), a subset of COMPLETED', () => {
    const kpis = computeHomeKpis([
      row({ status: 'CLOSED', workType: 'TROUBLESHOOT' }),
      row({ status: 'CLOSED', workType: 'INSTALL' }),
      row({ status: 'CLOSED_AUTO_RECOVERY', workType: 'TROUBLESHOOT' }),
    ]);

    expect(kpis.verified).toBe(1);
    // The auto-recovered TROUBLESHOOT ticket is neither VERIFIED (it never entered the three-phase
    // pipeline) nor COMPLETED (#229 D6) — it reached a terminal status without an SE touching it.
    expect(kpis.completed).toBe(2);
  });

  it('FAILED counts FAILED_VERIFICATION, FAILED_ACTIVATION, and ESCALATED', () => {
    const kpis = computeHomeKpis([
      row({ status: 'FAILED_VERIFICATION' }),
      row({ status: 'FAILED_ACTIVATION' }),
      row({ status: 'ESCALATED' }),
      row({ status: 'OPEN' }),
    ]);

    expect(kpis.failed).toBe(3);
  });
});
