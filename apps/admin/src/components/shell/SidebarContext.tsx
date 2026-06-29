import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Shell sidebar state (collapse + mobile drawer). Two orthogonal concerns:
 *  - `collapsed` — desktop icon-rail mode, persisted to localStorage so the choice survives reloads.
 *  - `mobileOpen` — the off-canvas drawer on narrow viewports; never persisted (transient).
 *
 * Pure presentation: this carries no role/zone/auth state, so the existing scoping logic is untouched.
 */
const STORAGE_KEY = 'fsm.admin.sidebar.collapsed';

function readPersistedCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private-mode / blocked storage — fall back to expanded.
    return false;
  }
}

interface SidebarState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(readPersistedCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, [collapsed]);

  // Stable action identities — the route-change effect in <Sidebar> depends on `closeMobile`, so it must
  // not change every render or it would re-fire and immediately re-close a just-opened drawer.
  const toggleCollapsed = useCallback(() => setCollapsedState((c) => !c), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const value = useMemo<SidebarState>(
    () => ({ collapsed, toggleCollapsed, mobileOpen, openMobile, closeMobile }),
    [collapsed, mobileOpen, toggleCollapsed, openMobile, closeMobile],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error('useSidebar must be used within a <SidebarProvider>');
  }
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export { STORAGE_KEY as SIDEBAR_STORAGE_KEY };
