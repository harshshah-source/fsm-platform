// Visual-parity capture manifest (delivers FE-00).
//
// Maps each v2 reference screenshot (docs/ui/desktop/v2-reference/NN-*.png) to the live route + the
// seeded login that renders it. The capture script (capture.mjs) drives the login form per role
// (session is React-state only — no boot-restore), navigates, and full-page-screenshots at 1440px.
//
// `role`   — seeded login key (see CREDS); null = capture logged out.
//
// PREREQUISITE: these accounts must exist on the database the backend is pointed at. They are
// created by `npm run seed:dev` in apps/backend (#194) — see docs/runbooks/local-development-login.md.
// Until that existed, every login here 401'd on any machine but the one that had hand-run the test
// fixture, which is the likeliest reason visual/baseline/ went un-recaptured after 2026-07-28.
// If you set DEV_SEED_PASSWORD when seeding, change the passwords below to match.
// `acting` — zone number to "Act as ZM for" (CSM/OH acting-as-zone view, reference 02).
// `open`   — 'firstTicket' opens the first row of /tickets as a detail drawer (references 08/09/28).

export const CREDS = {
  ZM: { email: 'zm.north@fsm.test', password: 'correct-password' },
  CSM: { email: 'csm@fsm.test', password: 'correct-password' },
  OH: { email: 'ops.head@fsm.test', password: 'correct-password' },
  WM: { email: 'wm@fsm.test', password: 'correct-password' },
};

/** @type {Array<{name:string, ref:string, route:string, role:string|null, acting?:number, open?:string, note?:string}>} */
export const SPECS = [
  { name: '00-login', ref: '00-login.png', route: '/login', role: null },
  { name: '01-dashboard-zm', ref: '01-dashboard-zonal-manager.png', route: '/', role: 'ZM' },
  { name: '02-dashboard-csm-acting', ref: '02-dashboard-csm-acting-as-zone.png', route: '/', role: 'CSM', acting: 1 },
  { name: '03-dashboard-central', ref: '03-dashboard-central-service.png', route: '/', role: 'CSM' },
  { name: '04-dashboard-ops-head', ref: '04-dashboard-operations-head.png', route: '/', role: 'OH' },
  { name: '05-dashboard-warehouse', ref: '05-dashboard-warehouse.png', route: '/', role: 'WM' },
  // Data-heavy manager pages: captured as OpsHead (all-zone visibility → populated tables). The
  // seeded ZM (zm.north / zone 1) has no tickets in the dev DB, so ZM would render empty states.
  { name: '07-tickets', ref: '07-tickets.png', route: '/tickets', role: 'OH' },
  { name: '08-ticket-detail', ref: '08-ticket-detail.png', route: '/tickets', role: 'CSM', open: 'firstTicket', note: 'CSM = manager controls + all-zone data' },
  { name: '09-ticket-detail-ops-readonly', ref: '09-ticket-detail-ops-head-readonly.png', route: '/tickets', role: 'OH', open: 'firstTicket' },
  { name: '10-readiness-vehicle-unavailability', ref: '10-readiness.png', route: '/readiness/vehicle-unavailability', role: 'OH' },
  { name: '11-vehicle-unavailability', ref: '11-vehicle-unavailability.png', route: '/readiness/vehicle-unavailability', role: 'OH' },
  { name: '12-schedules', ref: '12-batch-schedule-review.png', route: '/schedules', role: 'OH' },
  { name: '13-intraday', ref: '13-intraday-queue.png', route: '/intraday', role: 'OH' },
  { name: '14-verification', ref: '14-verification-review.png', route: '/verification', role: 'OH' },
  { name: '15-se-activity', ref: '15-se-activity.png', route: '/engineers', role: 'OH' },
  { name: '16-se-planner', ref: '16-se-planner.png', route: '/engineers/planner', role: 'OH' },
  { name: '17-component-blocked', ref: '17-component-blocked-queue.png', route: '/component-blocked', role: 'OH' },
  { name: '18-component-requests', ref: '18-component-requests.png', route: '/warehouse/requests', role: 'WM' },
  { name: '19-shadow-use', ref: '19-shadow-use-queue.png', route: '/warehouse/shadow-use', role: 'WM' },
  { name: '20-warehouse-stock', ref: '20-warehouse-stock.png', route: '/', role: 'WM', note: 'warehouse stock lives on the WM dashboard' },
  { name: '21-reports', ref: '21-reports.png', route: '/reports', role: 'OH' },
  { name: '22-device-detail', ref: '22-device-detail.png', route: '/reports/device', role: 'OH' },
  { name: '23-root-cause', ref: '23-root-cause-analytics.png', route: '/reports/root-cause', role: 'OH' },
  { name: '24-system-efficiency', ref: '24-system-efficiency.png', route: '/reports/system-efficiency', role: 'OH' },
  { name: '25-zm-scorecard', ref: '25-zm-performance-scorecard.png', route: '/reports/zm-scorecard', role: 'OH' },
  { name: '26-settings', ref: '26-settings.png', route: '/settings', role: 'OH' },
  { name: '27-help', ref: '27-help-center.png', route: '/help', role: 'OH' },
  { name: '28-tickets-drawer', ref: '28-tickets-drawer.png', route: '/tickets', role: 'CSM', open: 'firstTicket' },
];

export const BASE_URL = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173';
export const VIEWPORT_WIDTH = 1440;
export const VIEWPORT_HEIGHT = 900;
