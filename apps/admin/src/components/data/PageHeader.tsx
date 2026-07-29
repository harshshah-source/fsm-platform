import type { ReactNode } from 'react';

/**
 * Page title block — **visually removed**. The boxed title/subtitle banner that used to sit at the top
 * of every page is gone: the top bar's breadcrumb already names the page, so the card was a second,
 * larger copy of information the operator had just read, pushing the actual work below the fold on
 * every single screen.
 *
 * What survives, and why:
 *  - the title/subtitle stay in the DOM as a screen-reader-only heading. A page still needs one
 *    labelled landmark — the breadcrumb's last crumb is a `<span aria-current="page">`, not a heading,
 *    so deleting this outright would leave every page headingless for assistive tech;
 *  - `actions` still render, as a slim right-aligned row with no card around them. Pages that pass
 *    none (most of them) now contribute zero vertical space.
 *
 * The call signature is unchanged, so no page had to be edited for this.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="sr-only">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
    </>
  );
}
