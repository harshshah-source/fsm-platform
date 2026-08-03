import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { ProgressBar } from './ProgressBar';
import { color } from '../../theme/tokens';

describe('ProgressBar', () => {
  it('renders the filled segment proportional to value/max', () => {
    render(<ProgressBar value={3} max={4} testID="bar" />);

    const fill = screen.getByTestId('bar-fill');
    const flatStyle = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
    expect(flatStyle.width).toBe('75%');
  });

  it('clamps to 100% when value exceeds max, rather than overflowing the track', () => {
    render(<ProgressBar value={9} max={4} testID="bar" />);

    const fill = screen.getByTestId('bar-fill');
    const flatStyle = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
    expect(flatStyle.width).toBe('100%');
  });

  it('renders 0% (not NaN%) when max is 0, so an empty denominator never breaks layout', () => {
    render(<ProgressBar value={0} max={0} testID="bar" />);

    const fill = screen.getByTestId('bar-fill');
    const flatStyle = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
    expect(flatStyle.width).toBe('0%');
  });

  it('uses the success token by default, never a raw hex', () => {
    render(<ProgressBar value={1} max={2} testID="bar" />);

    const fill = screen.getByTestId('bar-fill');
    const flatStyle = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
    expect(flatStyle.backgroundColor).toBe(color.info);
  });
});
