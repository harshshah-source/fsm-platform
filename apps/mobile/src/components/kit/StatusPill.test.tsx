import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { StatusPill } from './StatusPill';
import { color } from '../../theme/tokens';

describe('StatusPill', () => {
  it('renders its label text', () => {
    render(<StatusPill label="High Critical" status="critical" />);

    expect(screen.getByText('High Critical')).toBeTruthy();
  });

  it('uses the tinted semantic bg/fg pair for its status, never a raw hex', () => {
    render(<StatusPill label="New" status="info" testID="pill" />);

    const pill = screen.getByTestId('pill');
    const flatStyle = Array.isArray(pill.props.style) ? Object.assign({}, ...pill.props.style) : pill.props.style;
    expect(flatStyle.backgroundColor).toBe(color.infoBg);
  });
});
