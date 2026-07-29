import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

const ERROR_TIP =
  'absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-critical-bg px-1.5 py-0.5 text-[11px] text-critical shadow-sm';

export interface EditableCellOption {
  value: string;
  label: string;
}

interface EditableCellBaseProps {
  ariaLabel: string;
  disabled?: boolean;
  /** Persist the value. Throw an `Error` with a user-facing message to signal failure. */
  onSave: (raw: string) => Promise<void>;
  /** Client-side guard before hitting the network; return an error message to block the save. */
  validate?: (raw: string) => string | null;
}

interface EditableCellProps extends EditableCellBaseProps {
  value: string;
  /** What renders in the idle (non-editing) state; defaults to `value`. */
  display?: ReactNode;
  type?: 'text' | 'number' | 'email';
  placeholder?: string;
}

/**
 * Click-to-edit text/number/email table cell (FE inline-edit primitive). Click → input, Enter/blur →
 * save, Escape → cancel. Save failures surface inline (below the cell) rather than reverting silently —
 * the value only ever changes after a confirmed successful save (pessimistic, not optimistic).
 */
export function EditableCell({
  value,
  display,
  ariaLabel,
  disabled,
  placeholder,
  type = 'text',
  validate,
  onSave,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const startEdit = () => {
    if (disabled || saving) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(value);
    setError(null);
    setEditing(false);
  };

  const commit = async () => {
    const next = draft.trim();
    if (next === value) {
      setEditing(false);
      setError(null);
      return;
    }
    if (type === 'number' && next !== '' && !Number.isFinite(Number(next))) {
      setError('Enter a valid number.');
      return;
    }
    const validationError = validate?.(next) ?? null;
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={startEdit}
        aria-label={ariaLabel}
        className={cn(
          '-mx-1.5 -my-1 block w-full rounded px-1.5 py-1 text-left transition-colors',
          !disabled && 'cursor-text hover:bg-surface-sunken/70',
          disabled && 'cursor-default',
        )}
      >
        {display ?? value}
      </button>
    );
  }

  return (
    <div className="relative">
      <input
        autoFocus
        type={type === 'number' ? 'number' : type === 'email' ? 'email' : 'text'}
        value={draft}
        placeholder={placeholder}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-8 w-full min-w-[7rem] rounded-md border bg-surface-card px-2 text-sm text-ink-strong shadow-sm',
          'focus-ring focus-visible:border-brand-600 disabled:opacity-60',
          error ? 'border-critical' : 'border-line',
        )}
      />
      {error && (
        <p role="alert" className={ERROR_TIP}>
          {error}
        </p>
      )}
    </div>
  );
}

interface EditableSelectCellProps extends EditableCellBaseProps {
  value: string;
  options: EditableCellOption[];
}

/** Always-live dropdown cell — selects don't need a click-to-edit gate. */
export function EditableSelectCell({
  value,
  ariaLabel,
  disabled,
  options,
  validate,
  onSave,
}: EditableSelectCellProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (raw: string) => {
    if (raw === value) return;
    const validationError = validate?.(raw) ?? null;
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled || saving}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        onChange={(e) => void change(e.target.value)}
        className={cn(
          'h-8 rounded-md border bg-surface-card px-2 text-sm text-ink-strong shadow-sm transition-colors',
          'hover:border-line-strong focus-ring focus-visible:border-brand-600 disabled:cursor-not-allowed disabled:opacity-70',
          error ? 'border-critical' : 'border-line',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className={ERROR_TIP}>
          {error}
        </p>
      )}
    </div>
  );
}

interface ToggleCellProps {
  active: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onToggle: () => Promise<void>;
}

/** Inline switch cell (e.g. active/inactive status) — click to flip, no separate edit mode. */
export function ToggleCell({ active, ariaLabel, disabled, onToggle }: ToggleCellProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (disabled || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onToggle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={ariaLabel}
        disabled={disabled || saving}
        onClick={() => void handleClick()}
        className={cn(
          'inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-60',
          active ? 'bg-success' : 'bg-neutral-bg ring-1 ring-inset ring-line',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-surface-card shadow transition-transform',
            active ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      {error && (
        <p role="alert" className={ERROR_TIP}>
          {error}
        </p>
      )}
    </div>
  );
}
