import { describe, expect, it } from '@jest/globals';
import { NavigationContainer } from '@react-navigation/native';
import { render, screen } from '@testing-library/react-native';
import { ConflictScreen } from './ConflictScreen';
import { TroubleshootConflictError } from '../../api/client';

function renderConflict(error: TroubleshootConflictError) {
  return render(
    <NavigationContainer>
      <ConflictScreen error={error} />
    </NavigationContainer>,
  );
}

describe('ConflictScreen', () => {
  it('renders the winner name and time, and the Shadow-Use line when shadowUseRecorded', () => {
    const error = new TroubleshootConflictError({
      code: 'TICKET_ALREADY_CLOSED',
      status: 'CLOSED',
      winnerSeId: 'se-2',
      winnerSeName: 'SE South',
      winnerAt: '2026-05-11T16:00:00Z',
      shadowUseRecorded: true,
    });

    renderConflict(error);

    expect(screen.getByText(/already closed by SE South/)).toBeTruthy();
    expect(screen.getByTestId('conflict-shadow-use-line')).toBeTruthy();
  });

  it('omits the Shadow-Use line when shadowUseRecorded is false', () => {
    const error = new TroubleshootConflictError({
      code: 'TICKET_ALREADY_CLOSED',
      status: 'CLOSED',
      winnerSeId: 'se-2',
      winnerSeName: 'SE South',
      winnerAt: '2026-05-11T16:00:00Z',
      shadowUseRecorded: false,
    });

    renderConflict(error);

    expect(screen.queryByTestId('conflict-shadow-use-line')).toBeNull();
  });

  it('does not name an SE for CLOSED_AUTO_RECOVERY (no winner exists)', () => {
    const error = new TroubleshootConflictError({
      code: 'TICKET_ALREADY_CLOSED',
      status: 'CLOSED_AUTO_RECOVERY',
      winnerSeId: null,
      winnerSeName: null,
      winnerAt: null,
      shadowUseRecorded: false,
    });

    renderConflict(error);

    expect(screen.getByText('This ticket was already closed.')).toBeTruthy();
  });

  it('renders View Van Stock and Go Back actions', () => {
    const error = new TroubleshootConflictError({
      code: 'TICKET_ALREADY_CLOSED',
      status: 'CLOSED',
      winnerSeId: 'se-2',
      winnerSeName: 'SE South',
      winnerAt: '2026-05-11T16:00:00Z',
      shadowUseRecorded: false,
    });

    renderConflict(error);

    expect(screen.getByTestId('conflict-view-van-stock')).toBeTruthy();
    expect(screen.getByTestId('conflict-go-back')).toBeTruthy();
  });
});
