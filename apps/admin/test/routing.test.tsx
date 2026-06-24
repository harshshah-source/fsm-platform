import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('Admin shell — auth routing', () => {
  it('redirects an unauthenticated visit to "/" to the login page', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
});
