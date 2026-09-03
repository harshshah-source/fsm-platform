import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfigInEffectPanel } from '../src/pages/dispatch/ConfigInEffectPanel';
import type { ConfigSnapshot } from '../src/api/dispatch-runs';

/**
 * #270 Q4 — the eligibility-mode row an operator actually reads (Config In Effect, on the dispatch
 * run detail page) states the `all-deployed` proxy's limitation instead of leaving it undocumented on
 * the surface where the setting is read. No behaviour change to the eligibility gate itself.
 */
const snapshot = (eligibility: string | undefined): ConfigSnapshot => ({
  priorityRules: [],
  settings: eligibility === undefined ? {} : { eligibility_mode: eligibility },
  capacity: {},
  scheduler: { businessSweepsEnabled: true, dispatchCron: '0 5 * * *' },
});

describe('#270 — eligibility proxy limitation text', () => {
  it('shows the proxy limitation when the live setting is the all-deployed interim proxy', () => {
    render(<ConfigInEffectPanel snapshot={snapshot('all-deployed')} />);
    expect(screen.getByText(/ACTIVE\/DEPLOYED vehicle proxy/)).toBeInTheDocument();
    expect(screen.getByText(/Phase 2 \(#116\)/)).toBeInTheDocument();
  });

  it('does not show the proxy caveat under the canonical pgi mode', () => {
    render(<ConfigInEffectPanel snapshot={snapshot('pgi')} />);
    expect(screen.queryByText(/ACTIVE\/DEPLOYED vehicle proxy/)).not.toBeInTheDocument();
  });

  it('does not show the proxy caveat when the setting was never captured', () => {
    render(<ConfigInEffectPanel snapshot={snapshot(undefined)} />);
    expect(screen.queryByText(/ACTIVE\/DEPLOYED vehicle proxy/)).not.toBeInTheDocument();
  });
});
