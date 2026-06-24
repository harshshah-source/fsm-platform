// CSV export helper (Issue 06). "Export to Excel" is delivered as a .csv download (opens directly
// in Excel) — zero new dependency, which keeps it deliverable under the FortiGate install block.

type Cell = string | number | null | undefined;

/** RFC-4180-ish CSV: quote any cell containing a comma, quote, or newline; double interior quotes. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const esc = (v: Cell): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

/** Triggers a browser download of `csv` as `filename` via an object URL. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
