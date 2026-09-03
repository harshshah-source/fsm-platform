import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Segmented control for chart-level controls — range pickers, view switches.
 *
 * This is MUI's `ToggleButtonGroup`, themed onto the app's tokens in `theme/muiTheme.ts` so it
 * renders as the same rounded pill rail the reference uses. It replaces a hand-rolled group of
 * `<button aria-pressed>` elements that had been copy-pasted per control; the MUI version brings
 * roving focus and arrow-key traversal between segments, which the hand-rolled one did not have
 * (every segment was a separate tab stop).
 *
 * The rendered DOM is still a plain `<button>` per segment carrying its visible label, so anything
 * selecting by role and name — the existing tests do exactly that — is unaffected.
 */
export function ChartSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: SegmentOption<T>[];
  ariaLabel: string;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      aria-label={ariaLabel}
      // Exclusive mode reports `null` when the ALREADY-selected segment is clicked. Swallowing it
      // keeps a selection always present — a range picker with nothing selected has no meaning.
      onChange={(_event, next: T | null) => {
        if (next != null) onChange(next);
      }}
    >
      {options.map((o) => (
        <ToggleButton key={o.value} value={o.value} aria-label={o.label} disableRipple>
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
