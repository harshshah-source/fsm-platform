import { PageHeader } from '../../components/data';
import { AssignWorkspace } from './AssignWorkspace';

/**
 * **Assign work** (`/assign`) — the standalone manual-assignment console (#273, approved direction
 * #272; the authoritative design is `docs/ui/desktop/approved-designs/assign-work-console.html`).
 *
 * The workspace itself is {@link AssignWorkspace}, which the Scheduler Console also renders as its
 * Assign mode. What is left here is the route: a page header, and the **absence** of a `zoneId`.
 *
 * That absence is the whole point of keeping this route (§14 **D4**, answered 2026-08-28). The
 * Console's Assign mode is deliberately narrowed to the zone its deck is showing, because two panes
 * on one screen that disagree about scope is a correctness bug. A CSM or Operations Head still needs
 * the pan-India pool — *where in the country is the work?* is a different question from *what is left
 * in this zone today?* — and it is asked here, on a surface with no zone-scoped deck beside it to
 * contradict.
 */
export function AssignConsolePage() {
  return (
    <AssignWorkspace
      header={(stage) =>
        stage === 'review' ? (
          <PageHeader
            title="Assign work"
            subtitle="The last screen before anything is written — a diff, not a confirmation dialog."
          />
        ) : (
          <PageHeader
            title="Assign work"
            subtitle="Everything unassigned in your scope, what you are about to hand out, and what will be left. Nothing is written until you commit — this draft lives in this browser tab only."
          />
        )
      }
    />
  );
}
