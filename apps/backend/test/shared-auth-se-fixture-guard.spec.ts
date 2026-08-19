import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_AUTH_SE_ID } from './fixtures/shared-auth-se';

/**
 * #255 AC-1 — cheap, permanent guard for the defect this issue fixed: the auth-seed SE
 * `se.north@fsm.test` is shared by sixteen e2e files, and each file creates its **own** plant. A file
 * that writes a `DEDICATED` `se_coverage` row for that SE therefore claims an exclusive relationship
 * it does not have — `se_coverage_dedicated_se_key`, the partial unique declared in raw SQL at
 * `prisma/migrations/20260618121101_add_engineer_se_coverage/migration.sql:60`, allows exactly one
 * `DEDICATED` row per SE across the whole table.
 *
 * Prisma cannot see that index (a partial unique is not expressible in the schema), so
 * `seCoverage.upsert({ where: { seId_plantId } })` targets `(se_id, plant_id)` only: two files at two
 * plants both pass the conflict check and both INSERT, and the index rejects whichever loses. The
 * throw happens in `beforeAll`, so the losing file reports **zero** tests rather than a failure —
 * silent coverage loss, and a suite verdict that has to be hand-triaged (see #107).
 *
 * The coverage-floor predicate these specs actually exercise (`SeCoverageService.coveredPlantIds`,
 * #162) ignores `coverage_type` entirely, so `MULTI_PLANT` is both the semantically honest type for
 * an SE that covers many plants and the one that cannot collide. Use
 * `ensureSharedSeCoversPlant()` from `test/fixtures/shared-auth-se.ts`.
 *
 * Pure static scan, no DB — fails the moment the mistake is reintroduced rather than on whichever
 * future run happens to order two of those files unluckily.
 *
 * A call may write `DEDICATED` for the shared SE only if it provably owns the table for the duration
 * (e.g. it truncates `se_coverage` itself) — opt out with a `shared-auth-se-guard-ok: <reason>`
 * comment within the 5 lines immediately before the call.
 */
const TEST_DIR = __dirname;
const THIS_FILE = 'shared-auth-se-fixture-guard.spec.ts';
const WRITE_RE = /seCoverage\.(?:create|createMany|upsert)\(/g;
const OPT_OUT_MARKER = 'shared-auth-se-guard-ok';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listTsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && entry.name !== THIS_FILE) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Extracts the balanced `(...)` call arguments starting at `openParenIdx`, skipping string/template
 * literal contents so a `)` inside a quoted string can't prematurely close the match. */
function extractCallArgs(text: string, openParenIdx: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIdx, i + 1);
    }
  }
  return text.slice(openParenIdx);
}

/** Every way a file can name the shared SE: the raw uuid, any local const bound to it, and the
 * exported constant if imported. A `seId:` argument spelled with any of these is the shared SE. */
function sharedSeAliases(text: string): string[] {
  const aliases = new Set<string>([SHARED_AUTH_SE_ID]);
  const literalDeclRe = new RegExp(`(?:const|let|var)\\s+(\\w+)[^=\\n]*=\\s*['"\`]${SHARED_AUTH_SE_ID}['"\`]`, 'g');
  for (const m of text.matchAll(literalDeclRe)) aliases.add(m[1]);
  if (/\bSHARED_AUTH_SE_ID\b/.test(text)) {
    aliases.add('SHARED_AUTH_SE_ID');
    // …and one hop of re-binding, the shape the migrated specs use: `const SE_ID = SHARED_AUTH_SE_ID;`
    for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)[^=\n]*=\s*SHARED_AUTH_SE_ID\b/g)) aliases.add(m[1]);
  }
  return [...aliases];
}

function referencesSharedSe(callArgs: string, aliases: string[]): boolean {
  return aliases.some((alias) =>
    alias === SHARED_AUTH_SE_ID
      ? callArgs.includes(alias)
      : new RegExp(`\\b${alias}\\b`).test(callArgs),
  );
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

interface Violation {
  file: string;
  line: number;
}

function scan(): { violations: Violation[]; sharedSeWrites: number } {
  const violations: Violation[] = [];
  let sharedSeWrites = 0;
  for (const filePath of listTsFiles(TEST_DIR)) {
    const text = readFileSync(filePath, 'utf8');
    const aliases = sharedSeAliases(text);
    for (const match of text.matchAll(WRITE_RE)) {
      const matchIndex = match.index ?? 0;
      const openParenIdx = matchIndex + match[0].length - 1;
      const callArgs = extractCallArgs(text, openParenIdx);
      if (!referencesSharedSe(callArgs, aliases)) continue;
      sharedSeWrites++;
      if (!/['"]DEDICATED['"]/.test(callArgs)) continue;

      const preceding = text.slice(Math.max(0, matchIndex - 400), matchIndex);
      if (preceding.includes(OPT_OUT_MARKER)) continue;

      violations.push({ file: filePath, line: lineNumberAt(text, matchIndex) });
    }
  }
  return { violations, sharedSeWrites };
}

describe('shared auth SE fixture guard (#255 AC-1)', () => {
  it('no spec writes a DEDICATED se_coverage row for the shared auth-seed SE', () => {
    const { violations } = scan();
    if (violations.length > 0) {
      const list = violations.map((v) => `  ${v.file}:${v.line}`).join('\n');
      throw new Error(
        `se_coverage write(s) claim coverage_type 'DEDICATED' for the shared auth-seed SE ` +
          `${SHARED_AUTH_SE_ID} (#255 — se_coverage_dedicated_se_key is a PARTIAL unique on (se_id) ` +
          `that Prisma cannot see, so two files at two plants both INSERT and the loser's beforeAll ` +
          `throws, reporting zero tests). Use ensureSharedSeCoversPlant() / MULTI_PLANT:\n${list}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('sanity — the scan actually finds shared-SE coverage writes (a guard that matches nothing is not a guard)', () => {
    const { sharedSeWrites } = scan();
    expect(sharedSeWrites).toBeGreaterThan(0);
  });
});

/**
 * #255 AC-3 — `se_coverage_se_id_fkey` is `ON DELETE RESTRICT`, so a teardown that clears
 * `engineer_master` before `se_coverage` throws instead of cleaning up. The order is invisible at the
 * call site (both are plain `deleteMany`s a few lines apart) and it only bites when a coverage row is
 * actually present, which is why it survived this long.
 */
const TEARDOWN_RE = /afterAll\(/g;

interface OrderViolation {
  file: string;
  line: number;
}

function findTeardownOrderViolations(): OrderViolation[] {
  const violations: OrderViolation[] = [];
  for (const filePath of listTsFiles(TEST_DIR)) {
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(TEARDOWN_RE)) {
      const matchIndex = match.index ?? 0;
      const body = extractCallArgs(text, matchIndex + match[0].length - 1);
      const engineerAt = body.search(/engineerMaster\.delete(?:Many)?\(/);
      const coverageAt = body.search(/seCoverage\.delete(?:Many)?\(|releaseSharedSePlantCoverage\(/);
      if (engineerAt === -1 || coverageAt === -1) continue;
      if (coverageAt < engineerAt) continue;
      violations.push({ file: filePath, line: lineNumberAt(text, matchIndex + engineerAt) });
    }
  }
  return violations;
}

describe('teardown FK ordering (#255 AC-3)', () => {
  it('every afterAll that clears both tables deletes se_coverage before engineer_master', () => {
    const violations = findTeardownOrderViolations();
    if (violations.length > 0) {
      const list = violations.map((v) => `  ${v.file}:${v.line}`).join('\n');
      throw new Error(
        `afterAll deletes engineer_master rows while se_coverage still references them — ` +
          `se_coverage_se_id_fkey is ON DELETE RESTRICT, so the teardown throws and leaves the ` +
          `fixtures behind for the next spec (#255):\n${list}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
