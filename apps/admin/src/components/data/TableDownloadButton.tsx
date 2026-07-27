import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ExportFormat } from '../../lib/exportFile';
import { Button } from '../ui/Button';
import { IconDownload } from '../ui/icons';

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'excel', label: 'Excel' },
  { value: 'pdf', label: 'PDF' },
  { value: 'img', label: 'Image (PNG)' },
];

/**
 * One button, one control per table (Issue 160, decision 3) — table-level export of every visible
 * row/column in CSV / Excel / PDF / PNG. Deliberately a single button + dropdown, not the two-control
 * `ExportMenu`: "one download button per table", literally.
 */
export function TableDownloadButton({
  ariaLabel,
  disabled,
  onSelectFormat,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onSelectFormat: (format: ExportFormat) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-label={`Download ${ariaLabel}`}
        >
          <IconDownload className="h-3.5 w-3.5" />
          Download
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-30 min-w-[9rem] rounded-md border border-line bg-surface-card p-1 shadow-card"
        >
          {FORMAT_OPTIONS.map((opt) => (
            <DropdownMenu.Item
              key={opt.value}
              onSelect={() => onSelectFormat(opt.value)}
              className="cursor-pointer select-none rounded-sm px-2.5 py-1.5 text-sm text-ink outline-none hover:bg-surface-sunken focus:bg-surface-sunken"
            >
              {opt.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
