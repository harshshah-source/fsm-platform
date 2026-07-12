// Presentation-only plant-label helper. AutoPlant supplies plant identifiers as short codes
// (e.g. `ACP-9106`) and does NOT carry the full plant names — that mapping is business knowledge
// only. This module holds the canonical prefix→name map and turns a raw identifier into a friendly
// display label WITHOUT losing the original code (it stays in parentheses, so anything a reader might
// cross-reference back to AutoPlant is preserved). Display-only: `plantId` remains the key/filter/
// group/route everywhere; only the rendered label changes.
//
// To add a plant, add its prefix here — no other file changes needed.

/** Canonical plant-code prefix → full plant name (business-provided). Extend as new prefixes appear. */
export const PLANT_FULL_NAME: Record<string, string> = {
  ACP: 'ARASMETA CEMENT PLANT',
  BCP: 'BIHAR CEMENT PLANT',
  CCP: 'CHITTOR CEMENT PLANT',
  HCP: 'HARYANA CEMENT PLANT',
  JCP: 'JOJOBERA CEMENT PLANT',
  MCP: 'MEJIA CEMENT PLANT',
  NCP: 'NIMBOL CEMENT PLANT',
  OCP: 'ODISHA CEMENT PLANT',
  PCP: 'PANAGARH CEMENT PLANT',
  RCP: 'RISDA CEMENT PLANT',
  SCP: 'SONADIH CEMENT PLANT',
};

/**
 * The code prefix of a plant identifier — the segment before the first `-` or `_`, upper-cased.
 * `ACP-9106` → `ACP`, `RCP_NVL_HUB` → `RCP`, `Yard-1` → `YARD`, `Mumbai Yard` → `MUMBAI YARD`.
 */
export function plantCodePrefix(raw: string): string {
  return raw.trim().split(/[-_]/)[0].toUpperCase();
}

/**
 * The structured parts of a plant identifier — `full` is the mapped name (or `null` when the prefix
 * is unmapped or the input is blank), `id` is the original identifier trimmed. This is the single
 * resolution point; both the string formatter and the `<PlantName>` component build on it, so the
 * mapping lives in exactly one place. Never throws.
 */
export function resolvePlantName(raw: string | null | undefined): { full: string | null; id: string } {
  if (raw == null) return { full: null, id: '' };
  const id = String(raw).trim();
  if (id === '') return { full: null, id: '' };
  return { full: PLANT_FULL_NAME[plantCodePrefix(id)] ?? null, id };
}

/**
 * Friendly single-line plant label. `ACP-9106` → `ARASMETA CEMENT PLANT (ACP-9106)`. An unmapped or
 * name-style identifier (`Yard-1`, `Mumbai Yard`) is returned unchanged. Never throws; a nullish or
 * blank input returns `''` so callers keep full control of their own empty-state placeholder. Used
 * where only a string fits — CSV cells, `title`/tooltip text, aria labels. Two-line UI uses
 * `<PlantName>`, which shares `resolvePlantName` above.
 */
export function formatPlantDisplayName(raw: string | null | undefined): string {
  const { full, id } = resolvePlantName(raw);
  if (id === '') return '';
  return full ? `${full} (${id})` : id;
}
