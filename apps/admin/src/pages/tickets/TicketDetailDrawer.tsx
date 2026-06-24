import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiTicketDetail, type TicketDetail } from '../../api/tickets';
import { BucketBadge, InlineBadges } from './ticketBadges';

type TabId = 'Overview' | 'Lifecycle' | 'Forms' | 'Verification' | 'Components' | 'Assignment History';
const TABS: TabId[] = ['Overview', 'Lifecycle', 'Forms', 'Verification', 'Components', 'Assignment History'];

// Tabs whose data lands in later slices/issues; rendered as graceful stubs for now.
const STUB_TABS: Record<string, string> = {
  Forms: 'Troubleshooting / Install forms appear here once submitted (Issue 16).',
  Verification: 'GPS verification runs and outcome appear here (Issue 18/19).',
  Components: 'Component requests and consumption appear here (Issue 21/22).',
  'Assignment History': 'Assignment and override history appears here (Issue 11/13).',
};

/**
 * Ticket Detail Drawer (Issue 07, `/tickets/:ticketId`). Slides in over the list (the list stays
 * mounted via its parent route). Overview + Lifecycle render real data from `/api/tickets/:id`; the
 * remaining tabs are graceful stubs that fill in as their owning issues land.
 */
export function TicketDetailDrawer() {
  const { ticketId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Verification Review page (Issue 19) deep-links to a specific tab via `?tab=Verification`.
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabId>(
    initialTab && (TABS as string[]).includes(initialTab) ? (initialTab as TabId) : 'Overview',
  );

  useEffect(() => {
    if (!ticketId) return;
    let alive = true;
    apiTicketDetail(ticketId)
      .then((t) => alive && setTicket(t))
      .catch(() => alive && setError('Failed to load ticket'));
    return () => {
      alive = false;
    };
  }, [ticketId]);

  return (
    <aside
      aria-label="Ticket detail"
      className="ml-4 w-96 shrink-0 border-l bg-white p-4 shadow-lg"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Ticket detail</h3>
        <button
          type="button"
          onClick={() => navigate('/tickets')}
          aria-label="Close ticket detail"
          className="rounded border px-2 py-0.5 text-sm"
        >
          ✕
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div role="tablist" aria-label="Ticket detail tabs" className="mb-3 flex flex-wrap gap-1 border-b text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-2 py-1 ${tab === t ? 'border-b-2 border-slate-800 font-medium' : 'text-slate-500'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {!ticket && !error && <p className="text-sm text-slate-500">Loading…</p>}

      {ticket && (
        <div role="tabpanel">
          {tab === 'Overview' && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-500">Device</dt>
              <dd className="font-medium">{ticket.deviceId}</dd>
              <dt className="text-slate-500">Work type</dt>
              <dd>{ticket.workType}</dd>
              <dt className="text-slate-500">Status</dt>
              <dd>{ticket.status}</dd>
              <dt className="text-slate-500">Plant</dt>
              <dd>{ticket.plantId}</dd>
              <dt className="text-slate-500">Company tier</dt>
              <dd>{ticket.companyTier}</dd>
              <dt className="text-slate-500">Bucket</dt>
              <dd>
                <BucketBadge bucket={ticket.slaBucket} />
              </dd>
              <dt className="text-slate-500">Flags</dt>
              <dd>
                <InlineBadges ticket={ticket} />
              </dd>
            </dl>
          )}

          {tab === 'Lifecycle' && (
            <ol className="flex flex-col gap-2 text-sm">
              {ticket.lifecycle.length === 0 && <li className="text-slate-500">No transitions yet.</li>}
              {ticket.lifecycle.map((e, i) => (
                <li key={i} className="border-l-2 border-slate-200 pl-2">
                  <div className="font-medium">{e.toState}</div>
                  <div className="text-xs text-slate-500">
                    {e.fromState ? `from ${e.fromState} · ` : ''}
                    {e.actorRole ?? 'system'} · {new Date(e.at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {tab in STUB_TABS && (
            <p className="text-sm italic text-slate-400">{STUB_TABS[tab]} (coming soon)</p>
          )}
        </div>
      )}
    </aside>
  );
}
