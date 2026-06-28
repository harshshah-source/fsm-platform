// The shell moved to components/shell/AppShell (FE-02). This re-export keeps the historical import
// path (`components/AdminShell`) stable for AppRoutes and the existing tests.
export { AppShell as AdminShell } from './shell/AppShell';
