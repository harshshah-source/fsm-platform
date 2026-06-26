import { useAuth } from '../../auth/AuthProvider';
import { ManagerDashboard } from './ManagerDashboard';
import { WarehouseDashboard } from './WarehouseDashboard';

/**
 * Dashboard landing role selector (Issue 06 / FE-06 / FE-07 / FE-17). The Warehouse-Manager persona has
 * its own "Zone Warehouse Fulfillment" dashboard over the WM aggregations (so the manager-scoped
 * endpoints are never called for a WM); every other role goes to the manager dashboard, which itself
 * selects the ZM / Central / Pan-India variant by role + acting context.
 */
export function DashboardHome() {
  const { session } = useAuth();
  if (session?.role === 'WAREHOUSE_MANAGER') return <WarehouseDashboard />;
  return <ManagerDashboard />;
}
