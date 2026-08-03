import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PhotoCaptureRow } from './PhotoCaptureRow';

describe('PhotoCaptureRow', () => {
  // #172 Decision 6 / D-12: Troubleshoot carries 4 NAMED slots, Vouchers 3 — never a flat string[].
  const troubleshootSlots = [
    { key: 'before', label: 'Before', photoRef: null },
    { key: 'after', label: 'After', photoRef: null },
    { key: 'part', label: 'Part', photoRef: null },
    { key: 'plate', label: 'Plate', photoRef: null },
  ];

  it('renders one capture affordance per named slot, labelled by slot, not by index', () => {
    render(<PhotoCaptureRow slots={troubleshootSlots} onCapture={jest.fn()} />);

    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.getByText('Part')).toBeTruthy();
    expect(screen.getByText('Plate')).toBeTruthy();
  });

  it('calls onCapture with the slot key, never a positional index', () => {
    const onCapture = jest.fn();
    render(<PhotoCaptureRow slots={troubleshootSlots} onCapture={onCapture} />);

    fireEvent.press(screen.getByText('Part'));

    expect(onCapture).toHaveBeenCalledWith('part');
  });

  it('shows a filled indicator for a slot that already holds an opaque photoRef', () => {
    const slots = [
      { key: 'before', label: 'Before', photoRef: 'media-ref-abc123' },
      { key: 'after', label: 'After', photoRef: null },
    ];
    render(<PhotoCaptureRow slots={slots} onCapture={jest.fn()} />);

    expect(screen.getByTestId('slot-before-filled')).toBeTruthy();
    expect(screen.queryByTestId('slot-after-filled')).toBeNull();
  });

  it('supports a 3-slot voucher shape with the same component (Receipt/Photo/Bill)', () => {
    const voucherSlots = [
      { key: 'receipt', label: 'Receipt', photoRef: null },
      { key: 'photo', label: 'Photo', photoRef: null },
      { key: 'bill', label: 'Bill', photoRef: null },
    ];
    render(<PhotoCaptureRow slots={voucherSlots} onCapture={jest.fn()} />);

    expect(screen.getByText('Receipt')).toBeTruthy();
    expect(screen.getByText('Bill')).toBeTruthy();
  });
});
