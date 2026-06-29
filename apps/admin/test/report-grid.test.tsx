import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportGrid } from '../src/components/charts/ReportGrid';

/** FE-21 — ReportGrid composition wrapper for paired report panels. */
describe('ReportGrid', () => {
  it('renders its children within a responsive 2-up grid', () => {
    render(
      <ReportGrid>
        <div>panel-a</div>
        <div>panel-b</div>
      </ReportGrid>,
    );
    expect(screen.getByText('panel-a')).toBeInTheDocument();
    expect(screen.getByText('panel-b')).toBeInTheDocument();
  });
});
