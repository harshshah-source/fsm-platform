import { Link, useLocation } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/data';
import { IconSearch } from '../components/ui/icons';

/**
 * #281 AC11 (audit §2.5 D3) — the shell's catch-all.
 *
 * Before this, `AppRoutes` had no `path="*"`: a mistyped or retired admin URL matched nothing, so the
 * pathless layout route never rendered and the operator got a blank document — no sidebar, no
 * breadcrumb, no message, no way back except the browser's Back button. It is routed *inside* the
 * shell for exactly that reason; a full-page 404 would fix the blankness and keep the stranding.
 *
 * The unresolved path is echoed verbatim because the overwhelmingly common cause is a typo or a
 * pasted-and-truncated link, and an operator who cannot see what the browser actually asked for has
 * no way to tell those apart from a page that was retired.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <section>
      <PageHeader title="Page not found" subtitle={`No admin page is routed at ${pathname}.`} />

      <div data-testid="not-found">
        <EmptyState
          icon={<IconSearch />}
          message={`No admin page is routed at ${pathname}. The address may be mistyped, or the page may have been retired.`}
          action={
            <Link
              to="/"
              className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm text-brand-600 hover:bg-surface-alt"
            >
              Back to the dashboard
            </Link>
          }
        />
      </div>
    </section>
  );
}
