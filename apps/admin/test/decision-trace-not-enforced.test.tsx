import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionTraceView } from '../src/pages/dispatch/DecisionTrace';
import type { DispatchTicketTrace } from '../src/api/dispatch-runs';

/**
 * #270 — the trace drawer renders NOT_ENFORCED distinctly (muted, "data source pending"), never as a
 * pass, and stays silent for older backend builds that don't send the field (version skew).
 */
const baseTrace = (notEnforcedFilters?: string[]): DispatchTicketTrace => ({
  runId: 'r1',
  ticketId: 't1',
  seId: 'se1',
  scoreBreakdown: null,
  recStatus: 'SUGGESTED',
  seNames: { se1: 'Engineer One' },
  trace: {
    candidatesTotal: 1,
    passedCount: 1,
    dropCounts: {},
    scoreDegenerate: true,
    poolEmptyReason: null,
    notEnforcedFilters,
    chosen: {
      seId: 'se1',
      coverageType: 'DEDICATED',
      precedenceRank: 1,
      plannerPlanned: false,
      plannerBias: false,
      capacityAtDecision: { used: 1, cap: 5 },
      clusterSeed: true,
    },
    runnersUp: [],
  },
});

describe('#270 — decision trace NOT_ENFORCED rendering', () => {
  it('shows a muted "data source pending" note listing the stubbed filters', () => {
    render(<DecisionTraceView data={baseTrace(['VEHICLE_ON_TRIP', 'COMPONENT_UNAVAILABLE'])} />);
    const note = screen.getByTestId('not-enforced-filters');
    expect(note).toHaveTextContent('VEHICLE_ON_TRIP');
    expect(note).toHaveTextContent('COMPONENT_UNAVAILABLE');
    expect(note).toHaveTextContent('Not enforced');
  });

  it('renders nothing when every filter is enforced', () => {
    render(<DecisionTraceView data={baseTrace([])} />);
    expect(screen.queryByTestId('not-enforced-filters')).not.toBeInTheDocument();
  });

  it('renders nothing for an older backend build that never sent the field', () => {
    render(<DecisionTraceView data={baseTrace(undefined)} />);
    expect(screen.queryByTestId('not-enforced-filters')).not.toBeInTheDocument();
  });
});
