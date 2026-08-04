import type { VanStockView } from '@fsm/shared';

export interface VanStockRow {
  componentId: string;
  name: string;
  qty: number;
  status: 'LOW' | 'OK';
}

/**
 * `VanStockItem` carries no status/threshold column — LOW vs OK is derived by cross-referencing
 * `CommonKitStatus.missing` (already the server's own "below required minimum" signal, via
 * `commonKitStatus()`'s `have < k.minQty` check), not a client-side threshold guess. A component
 * required by the kit but entirely absent from `stock` (no `se_van_stock` row at all) is
 * synthesized as a qty:0 LOW row — 0 is its real quantity, not fabricated data — matching
 * docs/ui/mobile/inventory.png's "Battery" row exactly.
 */
export function mergeVanStockRows(view: VanStockView): VanStockRow[] {
  const missingIds = new Set(view.commonKit.missing.map((m) => m.componentId));
  const rows: VanStockRow[] = view.stock.map((item) => ({
    componentId: item.componentId,
    name: item.name,
    qty: item.qty,
    status: missingIds.has(item.componentId) ? 'LOW' : 'OK',
  }));

  const stockIds = new Set(view.stock.map((s) => s.componentId));
  for (const missing of view.commonKit.missing) {
    if (!stockIds.has(missing.componentId)) {
      rows.push({ componentId: missing.componentId, name: missing.name, qty: 0, status: 'LOW' });
    }
  }
  return rows;
}

/** The three summary tiles (docs/ui/mobile/inventory.png: "13 AVAILABLE / 3 LOW STOCK /
 *  2 HEALTHY") — AVAILABLE is Sigma qty, the other two are row counts by status. */
export function vanStockSummary(rows: VanStockRow[]): { available: number; low: number; healthy: number } {
  return {
    available: rows.reduce((sum, r) => sum + r.qty, 0),
    low: rows.filter((r) => r.status === 'LOW').length,
    healthy: rows.filter((r) => r.status === 'OK').length,
  };
}
