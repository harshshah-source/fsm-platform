import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #277 — a repo-wide guard against the exact failure mode this issue absorbed: `CriticalQueue.tsx`
 * had a working engineer picker, one-click assign and the `#249` deferral-confirm flow, and was
 * imported by **zero** files in `apps/admin/src` (only its own tests rendered it). Nothing caught
 * that; this sweep exists so the next dead surface is a failing test instead of a silent orphan
 * somebody finds a year later.
 *
 * **Heuristic, not a full module-graph resolver.** A file is "used" if some *other* file under `src`
 * (not `test`) has an import specifier ending in `/<basename>'` or `/<basename>"` — cheap, and enough
 * to catch the CriticalQueue shape (a component with a real host that stopped rendering it). It does
 * not understand barrel re-exports one level removed, so an `index.ts` barrel is exempted outright
 * (its own files are checked individually) and a file legitimately reachable only through one is a
 * false positive worth a documented exception, not a broken sweep.
 *
 * **A file's own test importing it does not count.** `CriticalQueue.tsx` had five dedicated unit
 * tests and was still the orphan this issue exists to name — a component only ever rendered by its
 * own test suite is exactly the case the sweep must catch, so only `src` counts as a user.
 */
const SRC = path.resolve(__dirname, '../src');

/** Entry points Vite/the app boot from outside any `src` import (index.html, the type-decl file). */
const ENTRY_POINTS = new Set(['main', 'App', 'vite-env']);

/**
 * Pre-existing orphans this sweep found that #277 did not create and is not scoped to fix — #136,
 * committed before this issue, untouched by it. Listed by design-doc name so a future sweep failure
 * for a *different* file is never mistaken for one of these.
 */
const KNOWN_PRE_EXISTING_ORPHANS = new Set(['ZoneOperatingModeCard', 'ZoneOperatingModeTable']);

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(p));
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('#277 — no admin component is imported by nothing', () => {
  it('every src file has at least one importer elsewhere in src (barrels and known exceptions aside)', () => {
    const files = walk(SRC);
    const contents = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

    const orphans: string[] = [];
    for (const file of files) {
      const base = path.basename(file).replace(/\.(tsx|ts)$/, '');
      if (base === 'index' || ENTRY_POINTS.has(base) || KNOWN_PRE_EXISTING_ORPHANS.has(base)) continue;

      const importedPattern = new RegExp(`from ['"][^'"]*/${base}['"]`);
      const used = files.some((other) => other !== file && importedPattern.test(contents.get(other)!));
      if (!used) orphans.push(path.relative(SRC, file));
    }

    expect(orphans).toEqual([]);
  });

  it('CriticalQueue.tsx — the specific orphan this issue absorbed — is gone, not merely re-imported', () => {
    expect(fs.existsSync(path.join(SRC, 'pages/dashboard/CriticalQueue.tsx'))).toBe(false);
  });
});
