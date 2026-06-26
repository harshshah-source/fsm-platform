import { Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../ui/Button';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/**
 * Authenticated application frame (FE-02). Replaces the plain `AdminShell` chrome with the reference
 * shell: dark role-grouped sidebar + light top bar + dark footer, with the acting banner riding under
 * the top bar. Role/zone scoping and the acting-context logic are unchanged — only the presentation.
 */
export function AppShell() {
  const { session, actingZone, setActingZone } = useAuth();
  if (!session) {
    return null;
  }

  return (
    <div className="flex min-h-screen bg-surface-app">
      <Sidebar role={session.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />

        {actingZone != null && (
          <div
            role="status"
            className="flex items-center justify-between bg-warning-bg px-6 py-2 text-sm text-warning"
          >
            <span>
              Acting as Zonal Manager for Zone {actingZone} (audited as {session.role})
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={() => setActingZone(null)}>
              Exit acting mode
            </Button>
          </div>
        )}

        <main className="flex-1 p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
