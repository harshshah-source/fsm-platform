// Table-level export support (Issue 160, decision 3). The read is a DOM read, deliberately — see
// AC-11/AC-16 and the trap in the issue: it is both the visible-view guarantee (what's exported
// equals what's on screen, post-filter and post-sort) and the zone-scoping proof (a network read
// could leak an out-of-zone row; a DOM read cannot show what was never rendered).

export interface TableExportResult {
  headers: string[];
  rows: string[][];
}

// A cell's own text, minus any nested `data-export-skip` content (e.g. the header sort-arrow glyph,
// which is presentation chrome, not part of the column label or the cell's value).
function cellText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[data-export-skip]').forEach((n) => n.remove());
  return (clone.textContent ?? '').trim();
}

/** Reads header/body text straight off the mounted table, skipping any `data-export-skip` cell. */
export function extractTableExport(table: HTMLTableElement): TableExportResult {
  const headers = Array.from(table.querySelectorAll('thead th'))
    .filter((th) => !th.hasAttribute('data-export-skip'))
    .map(cellText);

  const rows = Array.from(table.querySelectorAll('tbody tr[data-row-export]')).map((tr) =>
    Array.from(tr.querySelectorAll('td'))
      .filter((td) => !td.hasAttribute('data-export-skip'))
      .map(cellText),
  );

  return { headers, rows };
}

/** Lowercase, hyphenated filename stem from an arbitrary label (e.g. an `ariaLabel`). */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
