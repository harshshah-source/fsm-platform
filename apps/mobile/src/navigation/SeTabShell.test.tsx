import { describe, expect, it } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SeTabShell } from './SeTabShell';

describe('SeTabShell', () => {
  it('boots to the Home tab and registers all five nav entries', () => {
    render(<SeTabShell />);

    expect(screen.getByTestId('tab-Home')).toBeTruthy();
    expect(screen.getByTestId('tab-Tickets')).toBeTruthy();
    expect(screen.getByTestId('tab-Stock')).toBeTruthy();
    expect(screen.getByTestId('tab-Vouchers')).toBeTruthy();
    expect(screen.getByTestId('tab-Profile')).toBeTruthy();
    expect(screen.getByTestId('screen-home')).toBeTruthy();
  });

  it('switches screens when a different tab is pressed', () => {
    render(<SeTabShell />);

    fireEvent.press(screen.getByTestId('tab-Tickets'));

    expect(screen.getByTestId('screen-tickets')).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
  });
});
