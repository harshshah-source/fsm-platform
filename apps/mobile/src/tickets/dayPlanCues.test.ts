import { afterEach, describe, expect, it } from '@jest/globals';
import type { MeTicketRow } from '@fsm/shared';
import { __resetPlanCuesForTests, computePlanCues } from './dayPlanCues';

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
    plantName: 'Plant A',
    companyName: 'Co',
    companyTier: 'GOLD',
    slaBucket: null,
    deviceId: 'GPS1',
    vehicleId: null,
    vehicleNo: null,
    activeSoftState: null,
    ...overrides,
  } as MeTicketRow;
}

describe('computePlanCues', () => {
  afterEach(() => {
    __resetPlanCuesForTests();
  });

  it('no cache on first load → no cues', () => {
    const cues = computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b' })]);
    expect(cues.addedIds.size).toBe(0);
    expect(cues.removedRows).toEqual([]);
  });

  it('cached {A,B} → live {A,B,C}: C is added', () => {
    computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b' })]);
    const cues = computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b' }), row({ ticketId: 'c' })]);
    expect([...cues.addedIds]).toEqual(['c']);
    expect(cues.removedRows).toEqual([]);
  });

  it('cached {A,B} → live {A}: B shows removed, reconstructed from the cached row', () => {
    computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b', plantName: 'Plant B' })]);
    const cues = computePlanCues([row({ ticketId: 'a' })]);
    expect(cues.addedIds.size).toBe(0);
    expect(cues.removedRows).toHaveLength(1);
    expect(cues.removedRows[0]).toMatchObject({ ticketId: 'b', plantName: 'Plant B' });
  });

  it('a removed ticket keeps showing removed across later refreshes within the same session', () => {
    computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b' })]);
    computePlanCues([row({ ticketId: 'a' })]);
    const cues = computePlanCues([row({ ticketId: 'a' })]);
    expect(cues.removedRows.map((r) => r.ticketId)).toEqual(['b']);
  });

  it('only diffs assigned:true rows — pool tickets never trigger added/removed cues', () => {
    computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'pool-1', assigned: false })]);
    const cues = computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'pool-2', assigned: false })]);
    expect(cues.addedIds.size).toBe(0);
    expect(cues.removedRows).toEqual([]);
  });

  it('a cold start (module reset) clears the removed label', () => {
    computePlanCues([row({ ticketId: 'a' }), row({ ticketId: 'b' })]);
    computePlanCues([row({ ticketId: 'a' })]);
    __resetPlanCuesForTests();

    const cues = computePlanCues([row({ ticketId: 'a' })]);
    expect(cues.removedRows).toEqual([]);
  });
});
