import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #183 R5/AC-7 — cheap, permanent guard for the exact defect this issue fixed: a
 * `companyTierOverride.create(...)` fixture that omits `createdAt` is valid on the day it is
 * written and silently rejected forever after, once `expires_at`'s frozen absolute value falls
 * behind the live `created_at` default (`company_tier_overrides_expiry_window_chk`). Pure static
 * scan, no DB — fails the moment the mistake is reintroduced rather than weeks later.
 *
 * A call may omit `createdAt` only when the row is provably safe without it (e.g. every date in the
 * fixture derives from a live `new Date()`, not a frozen constant) — opt out with a
 * `tier-override-fixture-guard-ok: <reason>` comment anywhere in the 5 lines immediately before the
 * `.create(` call. See `effective-tier-resolver.spec.ts` for the precedent.
 */
const TEST_DIR = __dirname;
const THIS_FILE = 'tier-override-fixture-guard.spec.ts';
const CALL_RE = /companyTierOverride\.create\(/g;
const OPT_OUT_MARKER = 'tier-override-fixture-guard-ok';

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
 * literal contents so a `)` inside a quoted reason string can't prematurely close the match. */
function extractCallArgs(text: string, openParenIdx: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIdx, i + 1);
    }
  }
  return text.slice(openParenIdx);
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

interface Violation {
  file: string;
  line: number;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of listTsFiles(TEST_DIR)) {
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(CALL_RE)) {
      const matchIndex = match.index ?? 0;
      const openParenIdx = matchIndex + match[0].length - 1;
      const callArgs = extractCallArgs(text, openParenIdx);
      if (/createdAt\s*:/.test(callArgs)) continue;

      const lookbackStart = Math.max(0, matchIndex - 400);
      const preceding = text.slice(lookbackStart, matchIndex);
      if (preceding.includes(OPT_OUT_MARKER)) continue;

      violations.push({ file: filePath, line: lineNumberAt(text, matchIndex) });
    }
  }
  return violations;
}

describe('tier-override fixture guard (#183 AC-7)', () => {
  it('every companyTierOverride.create() call sets createdAt explicitly, or carries a named opt-out', () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const list = violations.map((v) => `  ${v.file}:${v.line}`).join('\n');
      throw new Error(
        `companyTierOverride.create() call(s) omit createdAt with no opt-out comment (#183 R5 — ` +
          `created_at defaults to CURRENT_TIMESTAMP, a live clock; a frozen expiresAt paired with it ` +
          `is valid today and rejected forever once real time passes it):\n${list}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('sanity — the scan actually finds call sites (a guard that matches nothing is not a guard)', () => {
    let total = 0;
    for (const filePath of listTsFiles(TEST_DIR)) {
      const text = readFileSync(filePath, 'utf8');
      total += [...text.matchAll(CALL_RE)].length;
    }
    expect(total).toBeGreaterThan(0);
  });
});
