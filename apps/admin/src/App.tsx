import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './AppRoutes';
import { AuthProvider } from './auth/AuthProvider';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
