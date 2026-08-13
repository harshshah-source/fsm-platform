import { Prisma } from '../generated/prisma/client';

/**
 * "Recently commissioned" — the one definition, shared by every surface that means it (#235).
 *
 * Two consumers today and they are structurally different: the cohort report iterates FITMENTS
 * (`FROM device_commissioning`), while the device list filters DEVICES (`EXISTS (…)`). What they must
 * agree on is the window predicate itself, so that is what lives here rather than being spelled twice.
 *
 * The failure this prevents is concrete, not theoretical: the cohort page's plant rows link through to
 * the device list with the same window, and a reader who clicks a row showing 120 fitments and lands on
 * a list built from a second spelling of "recent" has been shown two different answers to one question.
 *
 * **Both fragments below alias the table `dc`.** A caller must bind that alias — see the two call
 * sites — which is deliberate: an unaliased fragment could be dropped into a query where
 * `installed_at` resolves to something else entirely.
 */

/** Start of a cohort window, `days` before `now`. The arithmetic, so two callers cannot round it differently. */
export function cohortWindowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 3_600_000);
}

/**
 * The window predicate over `device_commissioning dc`.
 *
 * The upper bound is not decoration. `installed_at` is mirrored from AutoPlant, which has no
 * constraint against a future date; without `<= until` a mis-keyed 2027 fitment would appear in every
 * window forever, including windows that end before it. Measured today there are zero future-dated
 * rows at source — which is exactly the kind of fact that holds until it does not.
 *
 * `installed_at` being NULL (~13% of source rows) drops out naturally: `NULL >= since` is not true.
 */
export function commissionedWithinWindow(since: Date, until: Date): Prisma.Sql {
  return Prisma.sql`dc.installed_at >= ${since} AND dc.installed_at <= ${until}`;
}

/**
 * The same window, as a device-level EXISTS — "this device has a fitment in the window".
 *
 * **Device grain, not fitment grain, and the difference is visible in the product.** A device
 * re-mapped twice inside the window is TWO fitments but ONE row here; measured live, 6.4% of cohort
 * devices carry more than one fitment in 90 days. That is why both surfaces label what they count
 * rather than leaving a reader to reconcile two numbers that are each correct.
 */
export function deviceCommissionedWithin(since: Date, until: Date): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM device_commissioning dc
    WHERE dc.device_id = ds.device_id AND ${commissionedWithinWindow(since, until)}
  )`;
}
