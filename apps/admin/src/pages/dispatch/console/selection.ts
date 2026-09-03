/**
 * The Console's selection model (Scheduler Console §3.2).
 *
 * **Exactly one object is selected at a time**, and it is one of five kinds. The Inspector below the
 * board renders that one object and nothing else — selecting an engineer in the personnel column and
 * selecting the same engineer through any other door are the *same* selection, because they are the
 * same object. (Until #295 those really were two places: the People rail and the board's row label.)
 *
 * Selection is reflected in the URL so a manager can send a colleague the exact thing they are looking
 * at. The encoding is deliberately flat (`?sel=ticket:<id>`) rather than a JSON blob: it survives a
 * copy-paste out of a chat window, and a malformed value degrades to "nothing selected" rather than
 * throwing on parse.
 *
 * **Multi-select is not modelled here on purpose.** It exists in exactly one place in the whole
 * product — `SPLIT_BATCH`, which takes `ticketIds: string[]` — and everywhere else it would imply a
 * bulk write the backend does not offer (#272 R8 rules per-item commit and per-item results). When
 * Split lands in Phase 2 it carries its own ticket-selection state inside the action, not here.
 */

export type SelectionKind = 'ticket' | 'stop' | 'engineer' | 'run';

export interface Selection {
  kind: SelectionKind;
  /** `ticketId` · `batchId` · `seId` · `runId`, by kind. */
  id: string;
}

const KINDS: SelectionKind[] = ['ticket', 'stop', 'engineer', 'run'];

/** `ticket:abc` → `{kind:'ticket', id:'abc'}`. Anything else → null (never a throw). */
export function parseSelection(raw: string | null | undefined): Selection | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at) as SelectionKind;
  const id = raw.slice(at + 1);
  if (!KINDS.includes(kind) || id.length === 0) return null;
  return { kind, id };
}

export function encodeSelection(sel: Selection): string {
  return `${sel.kind}:${sel.id}`;
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}
