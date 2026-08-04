import { describe, expect, it } from '@jest/globals';
import type { VanStockView } from '@fsm/shared';
import { mergeVanStockRows, vanStockSummary } from './vanStockDisplay';

// Fixture matches docs/ui/mobile/inventory.png exactly: rows GPS Unit(3,OK)/SIM Card(1,LOW)/
// Cable(7,OK)/Antenna(2,LOW)/Battery(0,LOW) -> tiles 13 AVAILABLE / 3 LOW STOCK / 2 HEALTHY.
const view: VanStockView = {
  stock: [
    { componentId: 'c-gps', name: 'GPS Unit', qty: 3 },
    { componentId: 'c-sim', name: 'SIM Card', qty: 1 },
    { componentId: 'c-cable', name: 'Cable', qty: 7 },
    { componentId: 'c-antenna', name: 'Antenna', qty: 2 },
  ],
  commonKit: {
    complete: false,
    missing: [
      { componentId: 'c-sim', name: 'SIM Card', shortBy: 1 },
      { componentId: 'c-antenna', name: 'Antenna', shortBy: 1 },
      { componentId: 'c-battery', name: 'Battery', shortBy: 2 },
    ],
  },
};

describe('mergeVanStockRows', () => {
  it('marks a stock row LOW when its componentId is in commonKit.missing', () => {
    const rows = mergeVanStockRows(view);
    const sim = rows.find((r) => r.componentId === 'c-sim');
    expect(sim).toMatchObject({ qty: 1, status: 'LOW' });
  });

  it('marks a stock row OK when it is not in commonKit.missing', () => {
    const rows = mergeVanStockRows(view);
    const gps = rows.find((r) => r.componentId === 'c-gps');
    expect(gps).toMatchObject({ qty: 3, status: 'OK' });
  });

  it('synthesizes a qty:0 LOW row for a missing component absent from stock entirely', () => {
    const rows = mergeVanStockRows(view);
    const battery = rows.find((r) => r.componentId === 'c-battery');
    expect(battery).toMatchObject({ qty: 0, status: 'LOW', name: 'Battery' });
  });

  it('produces exactly 5 rows (4 stock + 1 missing-only), no duplicates', () => {
    expect(mergeVanStockRows(view)).toHaveLength(5);
  });
});

describe('vanStockSummary', () => {
  it('sums qty for AVAILABLE and counts rows by status, matching the reference image (13/3/2)', () => {
    const rows = mergeVanStockRows(view);
    expect(vanStockSummary(rows)).toEqual({ available: 13, low: 3, healthy: 2 });
  });
});
