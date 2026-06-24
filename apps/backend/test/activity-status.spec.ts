import { deriveActivityStatus, resolveShiftEnd } from '../src/soft-state/activity-status';

/**
 * Issue 15, slice 7 — SE Activity Status derivation (AC#6, ADR-0023). A render-time display label,
 * never stored. Precedence: (1) SE_AVAILABILITY.status if not AVAILABLE wins; (2) active soft states —
 * TROUBLESHOOT_STARTED → BUSY, VIEWED/ON_SITE → ON_SITE; (3) shift + heartbeat — within 1 h of shift
 * end → SHIFT_ENDING, last_activity_at < now − 1 h → OFFLINE (app not recently used), else AVAILABLE.
 */
const NOW = new Date('2026-06-23T10:00:00Z');
const base = { availabilityStatus: 'AVAILABLE', activeSoftStateTypes: [] as const, lastActivityAt: NOW, shiftEnd: null, now: NOW };

describe('deriveActivityStatus (ADR-0023)', () => {
  it('returns the availability status when it is not AVAILABLE (planning flag wins)', () => {
    expect(deriveActivityStatus({ ...base, availabilityStatus: 'ON_LEAVE' })).toBe('ON_LEAVE');
    expect(deriveActivityStatus({ ...base, availabilityStatus: 'OFF_SHIFT' })).toBe('OFF_SHIFT');
  });

  it('BUSY when holding TROUBLESHOOT_STARTED (over ON_SITE/VIEWED)', () => {
    expect(deriveActivityStatus({ ...base, activeSoftStateTypes: ['ON_SITE', 'TROUBLESHOOT_STARTED'] })).toBe('BUSY');
  });

  it('ON_SITE when holding VIEWED or ON_SITE', () => {
    expect(deriveActivityStatus({ ...base, activeSoftStateTypes: ['VIEWED'] })).toBe('ON_SITE');
    expect(deriveActivityStatus({ ...base, activeSoftStateTypes: ['ON_SITE'] })).toBe('ON_SITE');
  });

  it('a soft state beats a stale heartbeat — OFFLINE never hides active field work', () => {
    // last_activity_at is 3 h stale, but the SE holds ON_SITE → still ON_SITE (OFFLINE ≠ not working).
    const stale = new Date(NOW.getTime() - 3 * 3_600_000);
    expect(deriveActivityStatus({ ...base, activeSoftStateTypes: ['ON_SITE'], lastActivityAt: stale })).toBe('ON_SITE');
  });

  it('SHIFT_ENDING within 1 h of shift end (no soft state)', () => {
    const shiftEnd = new Date(NOW.getTime() + 30 * 60_000); // 30 min away
    expect(deriveActivityStatus({ ...base, shiftEnd })).toBe('SHIFT_ENDING');
  });

  it('OFFLINE when the app has not pinged in over an hour (no soft state)', () => {
    const stale = new Date(NOW.getTime() - 2 * 3_600_000);
    expect(deriveActivityStatus({ ...base, lastActivityAt: stale })).toBe('OFFLINE');
    expect(deriveActivityStatus({ ...base, lastActivityAt: null })).toBe('OFFLINE');
  });

  it('AVAILABLE when AVAILABLE, no soft state, recently active, not near shift end', () => {
    expect(deriveActivityStatus({ ...base, lastActivityAt: new Date(NOW.getTime() - 5 * 60_000) })).toBe('AVAILABLE');
  });
});

describe('resolveShiftEnd', () => {
  it('projects a time-of-day shift end onto the current date', () => {
    const shiftTime = new Date('1970-01-01T18:30:00Z');
    const resolved = resolveShiftEnd(shiftTime, NOW);
    expect(resolved?.toISOString()).toBe('2026-06-23T18:30:00.000Z');
  });
  it('returns null when there is no shift end', () => {
    expect(resolveShiftEnd(null, NOW)).toBeNull();
  });
});
