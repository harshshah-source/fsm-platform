import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlantName } from '../src/components/domain';

describe('<PlantName>', () => {
  it('stacked: renders full name and the code on a separate muted mono line', () => {
    const { container } = render(<PlantName code="JCP-9105" />);
    expect(screen.getByText('JOJOBERA CEMENT PLANT')).toBeInTheDocument();
    const codeEl = screen.getByText('JCP-9105');
    expect(codeEl).toBeInTheDocument();
    // code line reuses the established id convention (mono + muted); it is a distinct element
    expect(codeEl.className).toContain('font-mono');
    expect(codeEl.className).toContain('text-ink-muted');
    // both values reachable via the tooltip even if the line wraps
    expect(container.firstChild).toHaveAttribute('title', 'JOJOBERA CEMENT PLANT (JCP-9105)');
  });

  it('inline: keeps name and code on one line, code muted mono', () => {
    render(<PlantName code="ACP-9106" variant="inline" />);
    const wrap = screen.getByText(/ARASMETA CEMENT PLANT/);
    expect(wrap).toHaveAttribute('title', 'ARASMETA CEMENT PLANT (ACP-9106)');
    const codeEl = screen.getByText('ACP-9106');
    expect(codeEl.className).toContain('font-mono');
  });

  it('unmapped identifier renders verbatim with no second line', () => {
    render(<PlantName code="Yard-1" />);
    const el = screen.getByText('Yard-1');
    expect(el).toBeInTheDocument();
    // no full-name mapping → the code is NOT rendered a second time
    expect(screen.getAllByText('Yard-1')).toHaveLength(1);
  });

  it('never renders a stray code line for blank input', () => {
    const { container } = render(<PlantName code={null} />);
    expect(container.textContent).toBe('');
  });

  it('preserves the raw code verbatim even when the prefix maps (case-insensitive)', () => {
    render(<PlantName code="acp-9106" />);
    expect(screen.getByText('ARASMETA CEMENT PLANT')).toBeInTheDocument();
    expect(screen.getByText('acp-9106')).toBeInTheDocument();
  });
});
