// Tabular file exports beyond CSV (Issue 122): Excel (SpreadsheetML 2003 .xls) and PDF, both
// generated in-browser with ZERO new dependencies (the FortiGate install block — same posture as
// `csv.ts`). One entry point, `exportTable`, fans out to csv / excel / pdf.

import { downloadCsv, toCsv } from './csv';

export type ExportCell = string | number | null | undefined;
export type ExportFormat = 'csv' | 'excel' | 'pdf';

const cellText = (v: ExportCell): string => (v === null || v === undefined ? '' : String(v));

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Excel ────────────────────────────────────────────────────────────────────────────────────────

const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SpreadsheetML 2003 workbook — a real Excel grid (typed numbers, bold header), no dependency. */
export function toExcelXml(sheetName: string, headers: string[], rows: ExportCell[][]): string {
  const cell = (v: ExportCell, styleId?: string): string => {
    const style = styleId ? ` ss:StyleID="${styleId}"` : '';
    if (typeof v === 'number' && Number.isFinite(v))
      return `<Cell${style}><Data ss:Type="Number">${v}</Data></Cell>`;
    return `<Cell${style}><Data ss:Type="String">${xmlEsc(cellText(v))}</Data></Cell>`;
  };
  const row = (cells: string[]): string => `<Row>${cells.join('')}</Row>`;
  const body = [
    row(headers.map((h) => cell(h, 'hdr'))),
    ...rows.map((r) => row(r.map((v) => cell(v)))),
  ].join('\n');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles><Style ss:ID="hdr"><Font ss:Bold="1"/></Style></Styles>
 <Worksheet ss:Name="${xmlEsc(sheetName).slice(0, 31)}"><Table>
${body}
 </Table></Worksheet>
</Workbook>`;
}

export function downloadExcel(filename: string, headers: string[], rows: ExportCell[][], sheetName = 'Export'): void {
  downloadBlob(filename, new Blob([toExcelXml(sheetName, headers, rows)], { type: 'application/vnd.ms-excel' }));
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────────

// A4 landscape in points; small margins keep wide operational tables readable.
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const TITLE_SIZE = 12;
const CELL_SIZE = 7;
const ROW_H = 12;

// Keep every emitted string WinAnsi-safe: escape PDF string delimiters, replace non-Latin-1 bytes.
const pdfEsc = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/** Rough Helvetica width heuristic (avg glyph ≈ 0.5em) — good enough for clipping cell text. */
const clip = (s: string, maxWidth: number, fontSize: number): string => {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * 0.52)));
  return s.length > maxChars ? s.slice(0, maxChars - 3) + '...' : s;
};

/** {@link toPdf} as a raw PDF string (before Latin-1 byte encoding) — the testable core. */
export function toPdfString(title: string, headers: string[], rows: ExportCell[][]): string {
  const usableW = PAGE_W - 2 * MARGIN;
  // Proportional column widths from content (header counts double), min 5% of the page each.
  const weights = headers.map((h, i) => {
    const longest = Math.max(h.length * 2, ...rows.map((r) => cellText(r[i]).length), 4);
    return longest;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => Math.max(usableW * 0.05, (w / totalWeight) * usableW));
  const colWSum = colW.reduce((a, b) => a + b, 0);
  colW.forEach((_, i) => (colW[i] = (colW[i] / colWSum) * usableW));

  const rowsPerPage = Math.floor((PAGE_H - 2 * MARGIN - TITLE_SIZE - 2 * ROW_H) / ROW_H);
  const pagesRows: ExportCell[][][] = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += rowsPerPage) pagesRows.push(rows.slice(i, i + rowsPerPage));

  const drawRow = (cells: string[], y: number, bold: boolean): string => {
    let x = MARGIN;
    const ops: string[] = [];
    cells.forEach((c, i) => {
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${CELL_SIZE} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${pdfEsc(clip(c, colW[i] - 4, CELL_SIZE))}) Tj ET`);
      x += colW[i];
    });
    return ops.join('\n');
  };

  const pageStreams = pagesRows.map((pageRows, pageIdx) => {
    const ops: string[] = [];
    let y = PAGE_H - MARGIN - TITLE_SIZE;
    ops.push(`BT /F2 ${TITLE_SIZE} Tf ${MARGIN} ${y.toFixed(1)} Td (${pdfEsc(title)}${pagesRows.length > 1 ? ` (page ${pageIdx + 1}/${pagesRows.length})` : ''}) Tj ET`);
    y -= ROW_H * 1.6;
    ops.push(drawRow(headers, y, true));
    // Rule under the header row.
    ops.push(`0.5 w ${MARGIN} ${(y - 3).toFixed(1)} m ${(PAGE_W - MARGIN).toFixed(1)} ${(y - 3).toFixed(1)} l S`);
    for (const r of pageRows) {
      y -= ROW_H;
      ops.push(drawRow(r.map(cellText), y, false));
    }
    return ops.join('\n');
  });

  // Assemble objects: 1 catalog, 2 pages, 3 F1, 4 F2, then per page: page obj + stream obj.
  const objects: string[] = [];
  const pageObjNums = pageStreams.map((_, i) => 5 + i * 2);
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageStreams.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`);
  pageStreams.forEach((stream, i) => {
    const pageNum = 5 + i * 2;
    const streamNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNum} 0 R >>\nendobj\n`,
    );
    objects.push(`${streamNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  const count = objects.length + 1;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

/**
 * Minimal single-font tabular PDF, hand-assembled (catalog/pages/font + one content stream per
 * page, correct xref offsets). Column widths are proportional to the longest cell per column.
 */
export function toPdf(title: string, headers: string[], rows: ExportCell[][]): Blob {
  const pdf = toPdfString(title, headers, rows);
  // Latin-1 encode so byte offsets match string indices (all content was sanitized to Latin-1).
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

export function downloadPdf(filename: string, title: string, headers: string[], rows: ExportCell[][]): void {
  downloadBlob(filename, toPdf(title, headers, rows));
}

/** One-call export in the chosen format; `basename` gets the right extension appended. */
export function exportTable(
  format: ExportFormat,
  basename: string,
  title: string,
  headers: string[],
  rows: ExportCell[][],
): void {
  if (format === 'csv') downloadCsv(`${basename}.csv`, toCsv(headers, rows));
  else if (format === 'excel') downloadExcel(`${basename}.xls`, headers, rows, title);
  else downloadPdf(`${basename}.pdf`, title, headers, rows);
}
