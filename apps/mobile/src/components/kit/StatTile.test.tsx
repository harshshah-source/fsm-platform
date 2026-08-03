import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { StatTile } from './StatTile';
import { color } from '../../theme/tokens';

describe('StatTile', () => {
  it('renders the value and label', () => {
    render(<StatTile value={3} label="STARTED" status="info" />);

    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('STARTED')).toBeTruthy();
  });

  it('uses the semantic token background for its status, never a raw hex', () => {
    render(<StatTile value={0} label="FAILED" status="critical" testID="tile" />);

    const tile = screen.getByTestId('tile');
    const flatStyle = Array.isArray(tile.props.style) ? Object.assign({}, ...tile.props.style) : tile.props.style;
    expect(flatStyle.backgroundColor).toBe(color.critical);
  });
});
