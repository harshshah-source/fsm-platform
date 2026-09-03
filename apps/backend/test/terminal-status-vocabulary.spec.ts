import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RESOLVED_TICKET_STATUSES } from '../src/ticketing/resolved-ticket-status';

/**
 * #308 AC1 — one terminal-ticket-status vocabulary, pinned.
 *
 * Four spellings existed, two of them divergent (four members against the canonical seven), sitting in
 * front of unguarded closure writes. Folding them is easy; *keeping* them folded is what needs a test,
 * because the failure mode is not a broken build — it is somebody writing the list out again, correctly,
 * next to code that needs it, and the two silently disagreeing months later. That is exactly how the
 * departure and export copies lost `FAILED_VERIFICATION`, `FAILED_ACTIVATION` and
 * `RECEIVED_AT_WAREHOUSE` in the first place.
 *
 * The scan is source-text based on purpose. An import-graph check would have missed the sixth copy this
 * slice found: `device.service.ts` had the set hand-written inside a raw-SQL `NOT IN (…)`, where nothing
 * typechecks it and it agreed with the canonical set by luck rather than by construction.
 */
const SRC = join(__dirname, '..', 'src');
const CANONICAL_FILE = join('ticketing', 'resolved-ticket-status.ts');

/** Statuses whose co-occurrence marks a hand-written copy of the terminal set (not the full enum). */
const MARKERS = ['CLOSED_AUTO_RECOVERY', 'CLOSED_NON_OPERATIONAL', 'FAILED_RECOVERY'] as const;

/**
 * The complete `TicketStatus` enum is legitimately spelled out in a few places (an Ops-Explorer filter's
 * `enumValues`, a ticket-queue status allow-list). Those are the *vocabulary*, not the terminal subset,
 * and they are recognisable by naming live statuses too.
 */
const LIVE_MARKERS = ['OPEN', 'VERIFICATION_PENDING', 'ESCALATED', 'SCHEDULED'] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'generated') sourceFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** A window of source text that mentions every marker within a few lines of each other. */
function spellsTheTerminalSet(text: string): boolean {
  const lines = text.split('\n');
  const WINDOW = 12;
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + WINDOW).join('\n');
    if (!MARKERS.every((m) => window.includes(`'${m}'`))) continue;
    // A window that also names live statuses is the full enum, not the terminal subset.
    if (LIVE_MARKERS.some((m) => window.includes(`'${m}'`))) continue;
    return true;
  }
  return false;
}

describe('#308 — the terminal-ticket-status set has exactly one spelling', () => {
  it('no file outside the canonical one writes the set out by hand', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(CANONICAL_FILE))
      .filter((f) => spellsTheTerminalSet(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split('\\').join('/'));

    // If this fails: import RESOLVED_TICKET_STATUSES instead of respelling it. If the consumer genuinely
    // needs a different set, derive it from the canonical one and say why, in the canonical file.
    expect(offenders).toEqual([]);
  });

  it('the canonical set is the seven terminal statuses', () => {
    // Pins the membership itself, so the fold cannot be "kept" by quietly narrowing what it folds to.
    expect([...RESOLVED_TICKET_STATUSES].sort()).toEqual([
      'CLOSED',
      'CLOSED_AUTO_RECOVERY',
      'CLOSED_NON_OPERATIONAL',
      'FAILED_ACTIVATION',
      'FAILED_RECOVERY',
      'FAILED_VERIFICATION',
      'RECEIVED_AT_WAREHOUSE',
    ]);
  });

  it('the scan actually detects a respelling — it is not vacuously green', () => {
    // The check above only means something if it would fire. This is the shape it must catch: the
    // four-member copy that `device-departure.service.ts` and `plant-deactivation.service.ts` carried.
    const respelled = `const TERMINAL_TICKET_STATUSES = [
      'CLOSED',
      'CLOSED_AUTO_RECOVERY',
      'CLOSED_NON_OPERATIONAL',
      'FAILED_RECOVERY',
    ];`;
    expect(spellsTheTerminalSet(respelled)).toBe(true);

    // …and it must not fire on the full enum, which several filters legitimately list.
    const fullEnum = `enumValues: ['OPEN', 'VERIFICATION_PENDING', 'CLOSED', 'CLOSED_AUTO_RECOVERY',
      'CLOSED_NON_OPERATIONAL', 'ESCALATED', 'FAILED_RECOVERY', 'SCHEDULED']`;
    expect(spellsTheTerminalSet(fullEnum)).toBe(false);
  });
});
