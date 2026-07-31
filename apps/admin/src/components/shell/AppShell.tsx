import type { MouseEvent } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../ui/Button';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { SidebarProvider, useSidebar } from './SidebarContext';
import { ThemeProvider } from './ThemeContext';
import { TopBar } from './TopBar';

/**
 * Authenticated application frame (FE-02). Replaces the plain `AdminShell` chrome with the reference
 * shell: dark role-grouped sidebar + light top bar + dark footer, with the acting banner riding under
 * the top bar. Role/zone scoping and the acting-context logic are unchanged — only the presentation.
 */
export function AppShell() {
  const { session } = useAuth();
  if (!session) {
    return null;
  }

  return (
    <ThemeProvider>
      <SidebarProvider>
        <ShellFrame role={session.role} />
      </SidebarProvider>
    </ThemeProvider>
  );
}

/**
 * Inner frame — lives under {@link SidebarProvider} so it can drive the collapse behaviour. Clicking
 * genuine background inside <main> collapses an expanded desktop rail (quiet, click-away dismissal that
 * mirrors the mobile scrim); clicks on interactive content — controls, links, or anything inside a
 * table — are left alone, and on the icon rail it's a no-op. Also keys the page container by route so a
 * fresh navigation fades in.
 */
// Interactive content that must never trigger a click-away collapse (controls + dense table bodies).
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, table, [role="button"], [role="link"], [role="menuitem"], [tabindex]';

function ShellFrame({ role }: { role: string }) {
  const { actingZone, setActingZone } = useAuth();
  const { collapsed, collapse } = useSidebar();
  const { pathname } = useLocation();

  // Click-away: collapse only when an expanded rail and the click landed on non-interactive background.
  const collapseFromBackground = (e: MouseEvent<HTMLElement>) => {
    if (collapsed) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
    collapse();
  };

  return (
    <div className="flex min-h-screen bg-transparent">
      <Sidebar role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />

        {actingZone != null && (
          <div
            role="status"
            className="flex items-center justify-between border-b border-warning/20 bg-warning-bg/90 px-6 py-2.5 text-sm text-warning shadow-sm"
          >
            <span>
              Acting as Zonal Manager for Zone {actingZone} (audited as {role})
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={() => setActingZone(null)}>
              Exit acting mode
            </Button>
          </div>
        )}

        {/* Minimal gutter by design: the shell already frames the content with the sidebar and top bar,
            so a wide inner margin only steals width from the tables — trimmed again (was
            px-3/sm:px-4/lg:px-5) after the dense Company/Plant Overview table needed the room. */}
        <main className="flex-1 px-2 py-3 sm:px-3 lg:px-4 lg:py-4" onClick={collapseFromBackground}>
          <div key={pathname} className="enterprise-page animate-page-in">
            <Outlet />
          </div>
        </main>
        <Footer />
      </div>
    </div>
  );
}
