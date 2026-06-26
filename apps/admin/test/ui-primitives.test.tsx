import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../src/components/ui/Badge';
import { Button } from '../src/components/ui/Button';
import { Card, SectionCard } from '../src/components/ui/Card';
import { Field, Input } from '../src/components/ui/Input';

describe('UI primitives (FE-01)', () => {
  it('Button renders children and is disabled while loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('Button danger variant applies the critical token', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: /delete/i }).className).toMatch(/critical/);
  });

  it('Badge applies its tone token', () => {
    render(<Badge tone="success">OK</Badge>);
    expect(screen.getByText('OK').className).toMatch(/success/);
  });

  it('SectionCard renders a heading and body', () => {
    render(<SectionCard title="Stock">body</SectionCard>);
    expect(screen.getByRole('heading', { name: /stock/i })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('Card renders its children', () => {
    render(<Card>hello</Card>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('Field associates its label with the control', () => {
    render(
      <Field label="Email Address" htmlFor="f-email">
        <Input id="f-email" />
      </Field>,
    );
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });
});
