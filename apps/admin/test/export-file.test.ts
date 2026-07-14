import { describe, expect, it } from 'vitest';
import { toExcelXml, toPdf, toPdfString } from '../src/lib/exportFile';

/**
 * Issue 122 — dependency-free tabular exports. The Excel (SpreadsheetML) and PDF generators are pure
 * string/blob builders; we assert their structural well-formedness + that data survives, escaping and
 * all, without needing a browser download.
 */
describe('exportFile — Excel (SpreadsheetML)', () => {
  it('emits a workbook with typed cells and escaped text', () => {
    const xml = toExcelXml('Sheet', ['Name', 'Count'], [['A & <B>', 3], ['plain', 0]]);
    expect(xml).toContain('<?mso-application progid="Excel.Sheet"?>');
    expect(xml).toContain('<Worksheet ss:Name="Sheet">');
    // Numbers are typed as Number, strings as String; XML special chars are escaped.
    expect(xml).toContain('<Data ss:Type="Number">3</Data>');
    expect(xml).toContain('A &amp; &lt;B&gt;');
    // Header cells carry the bold style.
    expect(xml).toContain('ss:StyleID="hdr"');
  });
});

describe('exportFile — PDF', () => {
  it('produces a valid single-font PDF with a header + rows', () => {
    expect(toPdf('My Report', [], []).type).toBe('application/pdf');
    const text = toPdfString('My Report', ['Device', 'Vehicle'], [
      ['900', 'RJ-14-AA'],
      ['901', 'GJ-01-BB'],
    ]);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('xref');
    // The title and a cell value are drawn into the content stream.
    expect(text).toContain('(My Report)');
    expect(text).toContain('(900)');
  });

  it('paginates a large table across multiple page objects', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [String(i), `v${i}`]);
    const text = toPdfString('Big', ['ID', 'Val'], rows);
    // More than one /Type /Page object once the rows overflow a single A4 page.
    const pages = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
  });
});
