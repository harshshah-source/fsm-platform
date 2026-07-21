import { useState } from 'react';
import type { ExportFormat } from '../../lib/exportFile';
import { Button } from '../ui';
import { IconDownload } from '../ui/icons';
import { FilterSelect } from './FilterBar';

/**
 * Format picker + Download button for tabular exports (Issue 122): CSV, Excel (.xls), PDF or PNG image,
 * all generated in-browser via `lib/exportFile` (no dependency). The page owns WHAT is exported — this
 * component only collects the format and fires `onExport(format)`.
 */
export function ExportMenu({
  onExport,
  label = 'Download',
  disabled,
}: {
  onExport: (format: ExportFormat) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  return (
    <span className="inline-flex items-center gap-1.5">
      <FilterSelect
        aria-label="Download format"
        value={format}
        onChange={(e) => setFormat(e.target.value as ExportFormat)}
        className="h-8 text-xs"
      >
        <option value="csv">CSV</option>
        <option value="excel">Excel</option>
        <option value="pdf">PDF</option>
        <option value="img">Image (PNG)</option>
      </FilterSelect>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onExport(format)}>
        <IconDownload className="h-3.5 w-3.5" />
        {label}
      </Button>
    </span>
  );
}
