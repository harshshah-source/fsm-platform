import { describe, expect, it } from 'vitest';
import { metadataChanges, metadataDetail, metadataReason } from '../src/api/auditTrail';

/**
 * #342 AC3 — reading `audit_logs.metadata` as from/to.
 *
 * The column is free-form JSONB and the writers already in `src/` use four different shapes for the
 * same idea. The ledger and the drawer's Audit tab must not each guess separately, so the reading
 * lives in one function — and these cases are the shapes actually present in the codebase today, not
 * a hypothetical schema. The last case matters most: a blob with no transition in it must degrade to
 * visible detail rather than to an empty cell, or the tab would silently drop most rows.
 */
describe('#342 — metadata from/to reading', () => {
  it('reads the canonical previous/next pair, named by `key` when the writer supplied one', () => {
    expect(metadataChanges({ key: 'SLA_HOURS', previous: '4', next: '6', timeZone: 'Asia/Kolkata' })).toEqual([
      { field: 'SLA_HOURS', from: '4', to: '6' },
    ]);
  });

  it('reads a prefixed pair and names the field from the suffix (`previousHours` / `newHours`)', () => {
    expect(metadataChanges({ previousHours: 4, newHours: 6, reason: 'peak season' })).toEqual([
      { field: 'hours', from: 4, to: 6 },
    ]);
  });

  it('reads a bare `previous` beside the single new value (`{ dealType, previous }`)', () => {
    expect(metadataChanges({ dealType: 'RENTAL', previous: 'SALE' })).toEqual([
      { field: 'dealType', from: 'SALE', to: 'RENTAL' },
    ]);
  });

  it('reads from/to and before/after pairs', () => {
    expect(metadataChanges({ from: 'OPEN', to: 'CLOSED' })).toEqual([{ field: 'value', from: 'OPEN', to: 'CLOSED' }]);
    expect(metadataChanges({ field: 'status', before: 'A', after: 'B' })).toEqual([
      { field: 'status', from: 'A', to: 'B' },
    ]);
  });

  it('reports no change for a blob that records none, and keeps its detail visible instead', () => {
    const metadata = { seId: 'se-9', ticketIds: ['t1', 't2'] };
    expect(metadataChanges(metadata)).toEqual([]);
    expect(metadataDetail(metadata)).toContain('seId: se-9');
    expect(metadataDetail(metadata)).toContain('ticketIds');
  });

  it('reads the operator justification under any of the names the writers use', () => {
    expect(metadataReason({ reason: 'vehicle broke down' })).toBe('vehicle broke down');
    expect(metadataReason({ reasonCode: 'RESOLVED' })).toBe('RESOLVED');
    expect(metadataReason({ overrideReason: 'customer escalation' })).toBe('customer escalation');
    expect(metadataReason(null)).toBeNull();
    expect(metadataReason({ seId: 'se-9' })).toBeNull();
  });

  it('survives a metadata value that is not an object', () => {
    expect(metadataChanges(null)).toEqual([]);
    expect(metadataChanges('BATCH_APPROVED')).toEqual([]);
    expect(metadataDetail(null)).toBeNull();
  });
});
