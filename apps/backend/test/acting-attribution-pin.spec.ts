import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #340 AC1 — no controller hardcodes `actedAsRole: null`.
 *
 * `acted_as_role` was non-null on **1 of 34,758** audit rows. Not because acting was rare, but
 * because eleven controllers built their actor by hand as
 * `{ userId: user.user_id, role: user.role, actedAsRole: null }` — a literal that discards the
 * attribution the request already carries. Every write those doors make under acting is recorded as
 * the caller's real role, which is precisely the case the column exists to distinguish.
 *
 * This is pinned statically rather than per-door because the defect is *copyable*: the shape is
 * three lines that look complete, and the next controller written by copy-paste reintroduces it
 * silently. A per-door e2e catches the doors that exist; this catches the twelfth.
 *
 * **Two occurrences are legitimate and are named here rather than pattern-excluded**, so that a
 * third cannot hide behind a loose exclusion: `auth/acting-context.ts` and
 * `common/guards/acting-context.guard.ts` each build the **non-acting** context, where
 * `actedAsRole: null` is the meaning, not an omission (#339).
 */
const SRC = join(__dirname, '..', 'src');

/** The only two places where `actedAsRole: null` states a fact rather than throwing one away. */
const LEGITIMATE_NON_ACTING_FALLBACKS = [
  join('auth', 'acting-context.ts'),
  join('common', 'guards', 'acting-context.guard.ts'),
];

const LITERAL = /actedAsRole\s*:\s*null/;

/**
 * Comments are stripped before matching. The literal is discussed *in prose* in several of the files
 * that fixed it — including this pin's own neighbours — and a doc-comment naming the defect is the
 * opposite of committing it. Stripping also means a real one cannot hide behind a `//`.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated') continue; // Prisma's client, not ours
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function hits(predicate: (relative: string) => boolean): string[] {
  return walk(SRC)
    .map((f) => ({ file: f, relative: f.slice(SRC.length + 1) }))
    .filter(({ relative }) => predicate(relative))
    .filter(({ file }) => LITERAL.test(code(readFileSync(file, 'utf8'))))
    .map(({ relative }) => relative);
}

describe('#340 AC1 — acting attribution is never hardcoded away', () => {
  it('no controller contains a literal `actedAsRole: null`', () => {
    expect(hits((r) => r.endsWith('.controller.ts'))).toEqual([]);
  });

  it('outside the controllers, the only occurrences are the two non-acting fallbacks', () => {
    expect(hits((r) => !r.endsWith('.controller.ts')).sort()).toEqual(
      [...LEGITIMATE_NON_ACTING_FALLBACKS].sort(),
    );
  });
});
