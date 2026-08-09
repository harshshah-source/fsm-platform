import { describe, expect, it } from '@jest/globals';
import type { MeTicketRow } from '@fsm/shared';
import { summarisePlant } from './plantSummary';

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
    plantName: 'Plant One',
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

describe('summarisePlant', () => {
  it('counts every ticket as inactive and reports zeroes for an empty stop', () => {
    expect(summarisePlant([])).toEqual({ inactive: 0, urgent: 0, inWork: 0, done: 0, total: 0 });
  });

  it('treats CRITICAL and worse as urgent, and everything below it as not', () => {
    const rows = [
      row({ ticketId: 'a', slaBucket: 'WARNING' }),
      row({ ticketId: 'b', slaBucket: 'EARLY_RISK' }),
      row({ ticketId: 'c', slaBucket: 'RISK' }),
      row({ ticketId: 'd', slaBucket: 'CRITICAL' }),
      row({ ticketId: 'e', slaBucket: 'HIGH_CRITICAL' }),
      row({ ticketId: 'f', slaBucket: 'SEVERE' }),
      row({ ticketId: 'g', slaBucket: 'VERY_SEVERE' }),
      row({ ticketId: 'h', slaBucket: 'LONG_PENDING' }),
      // A device with no bucket at all is inactive-but-unbanded, never urgent.
      row({ ticketId: 'i', slaBucket: null }),
    ];
    const summary = summarisePlant(rows);
    expect(summary.inactive).toBe(9);
    expect(summary.urgent).toBe(5);
  });

  it('counts started work and completed work with the same definitions the KPI strip uses', () => {
    const rows = [
      row({ ticketId: 'a', workState: 'IN_WORK' }),
      row({ ticketId: 'b', status: 'CLOSED' }),
      row({ ticketId: 'c', status: 'CLOSED_AUTO_RECOVERY' }),
      // A written-off vehicle is a closure but not work completed — excluded, matching `homeKpi.ts`.
      row({ ticketId: 'd', status: 'CLOSED_NON_OPERATIONAL' }),
      row({ ticketId: 'e', status: 'VERIFICATION_PENDING' }),
    ];
    expect(summarisePlant(rows)).toEqual({ inactive: 5, urgent: 0, inWork: 1, done: 2, total: 5 });
  });
});
