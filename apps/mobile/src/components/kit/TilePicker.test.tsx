import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { TilePicker } from './TilePicker';

describe('TilePicker', () => {
  const options = [
    { value: 'POWER_ISSUE', label: 'Power' },
    { value: 'WIRING_ISSUE', label: 'Wire' },
  ];

  it('renders every option label', () => {
    render(<TilePicker options={options} value={null} onChange={jest.fn()} testIDPrefix="issue" />);

    expect(screen.getByText('Power')).toBeTruthy();
    expect(screen.getByText('Wire')).toBeTruthy();
  });

  it('calls onChange with the pressed option value', () => {
    const onChange = jest.fn();
    render(<TilePicker options={options} value={null} onChange={onChange} testIDPrefix="issue" />);

    fireEvent.press(screen.getByTestId('issue-tile-WIRING_ISSUE'));

    expect(onChange).toHaveBeenCalledWith('WIRING_ISSUE');
  });

  it('marks the selected tile distinctly from unselected ones', () => {
    render(<TilePicker options={options} value="POWER_ISSUE" onChange={jest.fn()} testIDPrefix="issue" />);

    const selected = screen.getByTestId('issue-tile-POWER_ISSUE');
    const unselected = screen.getByTestId('issue-tile-WIRING_ISSUE');
    const selectedStyle = Array.isArray(selected.props.style) ? Object.assign({}, ...selected.props.style) : selected.props.style;
    const unselectedStyle = Array.isArray(unselected.props.style)
      ? Object.assign({}, ...unselected.props.style)
      : unselected.props.style;

    expect(selectedStyle.backgroundColor).not.toBe(unselectedStyle.backgroundColor);
  });
});
