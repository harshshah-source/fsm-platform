import { describe, expect, it } from '@jest/globals';
import { render, screen, within } from '@testing-library/react-native';
import { completionRatio, formatChartDate, WorkHistoryChart } from './WorkHistoryChart';

describe('formatChartDate', () => {
  it('renders the axis label straight off the IST date string', () => {
    expect(formatChartDate('2026-05-07')).toBe('07 May');
    expect(formatChartDate('2026-12-31')).toBe('31 Dec');
    expect(formatChartDate('2026-01-01')).toBe('01 Jan');
  });

  // The backend already resolved these to IST calendar dates. Routing them through `new Date` would
  // re-read them as UTC instants and re-render them in the device's zone — every bar one day off for
  // an SE whose phone sits west of UTC. Pinned here so nobody "simplifies" it back.
  it('does not depend on the device timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(formatChartDate('2026-05-07')).toBe('07 May');
      process.env.TZ = 'Pacific/Kiritimati';
      expect(formatChartDate('2026-05-07')).toBe('07 May');
    } finally {
      process.env.TZ = original;
    }
  });

  it('returns the raw value rather than throwing on a malformed date', () => {
    expect(formatChartDate('nonsense')).toBe('nonsense');
  });
});

describe('completionRatio', () => {
  it('is the completed share of the day\'s assigned work', () => {
    expect(completionRatio({ date: 'd', assigned: 8, completed: 4 })).toBe(0.5);
  });

  it('is 0 — never NaN — for a day with nothing assigned', () => {
    expect(completionRatio({ date: 'd', assigned: 0, completed: 0 })).toBe(0);
  });

  it('clamps a bar to its track even if the server ever disagreed with itself', () => {
    expect(completionRatio({ date: 'd', assigned: 2, completed: 5 })).toBe(1);
  });
});

describe('WorkHistoryChart', () => {
  it('renders one bar per day, labelled completed/assigned with a date axis', () => {
    render(
      <WorkHistoryChart
        days={[
          { date: '2026-05-07', assigned: 6, completed: 4 },
          { date: '2026-05-08', assigned: 8, completed: 5 },
        ]}
      />,
    );

    expect(screen.getByText('Assigned vs Completed')).toBeTruthy();
    expect(screen.getByText('Daily work status')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Assigned')).toBeTruthy();

    const first = within(screen.getByTestId('work-history-bar-2026-05-07'));
    expect(first.getByText('4/6')).toBeTruthy();
    expect(first.getByText('07 May')).toBeTruthy();
  });

  it('gives a taller fill to the day with the higher completion rate', () => {
    render(
      <WorkHistoryChart
        days={[
          { date: '2026-05-07', assigned: 10, completed: 2 },
          { date: '2026-05-08', assigned: 10, completed: 9 },
        ]}
      />,
    );

    const heightOf = (date: string) => {
      const style = screen.getByTestId(`work-history-fill-${date}`).props.style as { height?: number }[];
      return style.flat().find((s) => s && typeof s.height === 'number')!.height!;
    };
    expect(heightOf('2026-05-08')).toBeGreaterThan(heightOf('2026-05-07'));
    expect(heightOf('2026-05-07')).toBeGreaterThan(0);
  });

  it('shows an empty state rather than an axis-less frame when there is no series', () => {
    render(<WorkHistoryChart days={[]} />);
    expect(screen.getByTestId('work-history-empty')).toBeTruthy();
  });
});
