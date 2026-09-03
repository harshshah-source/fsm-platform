import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';

/**
 * #341 AC1 — **every manager write route takes its scope from the request's proven acting context.**
 *
 * The defect: acting narrowed five read controllers and the Scheduler Console's writes, and nothing
 * else. Fifty-seven hand-built `{ role: user.role, zoneId: user.zone_id }` scopes across twenty
 * controllers stayed pan-India whatever the header said — so a CSM acting in zone 2 closed a zone-1
 * ticket for real (`ticketing/tickets.controller.ts`). The claim was gated (#339) and recorded
 * (#340), and still did not narrow anything a manager could *do*.
 *
 * **Why a sweep and not sixty cases.** The AC asks for "a CSM acting in zone 2 gets 403/404 for a
 * zone-1 entity" on every manager write route. Driving that literally needs a valid, correctly-zoned
 * fixture per route: a fixture set larger than the slice, which rots, and in which a route whose
 * fixture is subtly wrong passes for the wrong reason. Worse, it says nothing about route
 * **sixty-one** — and a backlog whose defect is "somebody hand-built a scope" will get another one.
 *
 * So the contract is split, and this file is the half that does not rot:
 *
 * - **Here (structural), in two independent halves.** The reflection sweep says every manager write
 *   route *injects* `@CurrentScope()`/`@CurrentActor()`, which catches a route that scopes nothing at
 *   all. That is necessary and **not sufficient**: after #340 a handler can inject `@CurrentActor()`
 *   for attribution and still hand its service `{ role: user.role, zoneId: user.zone_id }` built from
 *   the claims — the injection is real, the scope is still pan-India, and a reflection-only sweep
 *   waves it through. So the second half pins the defect itself: **no controller builds a scope from
 *   `user.zone_id`.** Either check alone has a blind spot the other covers.
 * - **`acting-scope-write-doors.e2e-spec.ts` (behavioural):** the 403/404 actually happens, on the
 *   reproduced case and one door per scope shape. That is what proves this sweep guards something
 *   true rather than a naming convention.
 *
 * Neither alone is worth much. Together the e2e says the rule is real and the sweep says nothing
 * escapes it.
 *
 * The idiom is this repo's own: `global-guard-validation.e2e-spec.ts` sweeps the whole route map for
 * missing auth against an explicit allowlist, on the rule that **widening the allowlist must be a
 * deliberate edit**. `UNSCOPED` below is that allowlist, and every entry states why the route has no
 * zone to narrow to.
 */
/**
 * Every controller in the app, loaded through the test transform. A glob rather than a hand-kept list
 * is the whole point: a controller added tomorrow is swept the moment its file exists, which is what
 * makes this a barrier and not a snapshot. (`require()` cannot be used here — the raw `.ts` would skip
 * SWC and choke on constructor parameter properties.)
 */
const CONTROLLER_MODULES = import.meta.glob<Record<string, unknown>>('../src/**/*.controller.ts', {
  eager: true,
});

/** The roles that can act for a zone (#339). A route none of them can reach cannot be narrowed. */
const ACTING_CAPABLE = ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];

/** Nest's numeric `RequestMethod` for the verbs that change something. */
const WRITE_METHODS = new Map([
  [1, 'POST'],
  [2, 'PUT'],
  [3, 'DELETE'],
  [4, 'PATCH'],
]);

/** The factories `@CurrentScope()` / `@CurrentActor()` install — see those decorators' comments. */
const SCOPE_FACTORIES = new Set(['currentScopeFactory', 'currentActorFactory']);

/**
 * Routes that legitimately have no zone to narrow to. Each entry is a **reason**, not a suppression:
 * widening this list is the deliberate edit the sweep exists to force. Keyed `CONTROLLER.method`.
 */
const UNSCOPED: Record<string, string> = {
  // --- Pan-India jobs. The entity IS the whole fleet, so there is no zone for acting to narrow to,
  //     and all four are `@Roles('OPERATIONS_HEAD')` — a role that cannot gain reach by acting.
  'IntegrationSyncController.runPipeline':
    'the AutoPlant ingestion pipeline runs over every device there is; OH-only',
  'IntegrationSyncController.syncMasters':
    'the master-data sync mirrors the whole AutoPlant catalogue; OH-only',
  'SnapshotsController.run': 'a snapshot is of the entire fleet at an instant; OH-only',

  // --- Recomputes. Each rebuilds one report table for every zone at once: a zone-scoped recompute
  //     would leave the table half-current, which is worse than not running it. OH-only.
  'ReportsController.recompute': 'fleet-uptime is recomputed whole or not at all; OH-only',
  'ReportsController.recomputeEfficiency': 'as above, system efficiency; OH-only',
  'ReportsController.recomputeRootCause': 'as above, root cause; OH-only',
  'ReportsController.recomputeSoftInactive': 'as above, soft-inactive; OH-only',
  'ReportsController.recomputeZmScorecard': 'as above, the ZM scorecard; OH-only',

  // --- Writes whose zone is an explicit argument, already clamped where it is read.
  'CrossZoneController.sweep':
    'the sweep looks across zones by definition — narrowing it to one would defeat the escalation it exists to find',
  'SchedulesController.bulkUnassignRoute':
    'OH-only, and the target is the request body’s `scope`/`zoneId` pair guarded by the D-gate preview token; the caller never reaches an entity this decorator could clamp',

  // --- Not a write, and not live.
  'OpsExplorerController.query':
    'a read expressed as POST because its filter set is structured; the dataset layer applies its own row scoping (`ops-explorer-access.ts`)',
  'VehicleUnavailabilityController.confirmDate':
    'retired by #245 — the handler throws 410 GONE and reaches no service at all',
};

/**
 * The literal shape of the defect: a scope assembled from the caller's claims rather than from the
 * context `ActingContextGuard` proved. 57 of these lived across 20 controllers.
 *
 * Matched against comment-stripped source, because several of the files that fixed it now discuss it
 * in prose — and because a real one must not be able to hide behind a `//`. (Same reasoning as
 * #340's `acting-attribution-pin.spec.ts`.)
 */
const CLAIMS_SCOPE = /zoneId:\s*user\.zone_id/;
const CONTROLLER_DIR = join(__dirname, '..', 'src');

/** Controllers that may still read `user.zone_id`, with the reason. Widening this is a deliberate edit. */
const CLAIMS_SCOPE_ALLOWED: Record<string, string> = {};

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue; // Prisma's client, not ours
      controllerFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Controller files still building a scope from claims, as `dir/name.controller.ts`. */
function claimsScopeFiles(): string[] {
  return controllerFiles(CONTROLLER_DIR)
    .map((f) => ({ file: f, relative: f.slice(CONTROLLER_DIR.length + 1).split(sep).join('/') }))
    .filter(({ file }) => CLAIMS_SCOPE.test(code(readFileSync(file, 'utf8'))))
    .map(({ relative }) => relative)
    .filter((r) => CLAIMS_SCOPE_ALLOWED[r] === undefined)
    .sort();
}

interface Route {
  key: string;
  controller: string;
  method: string;
  verb: string;
  path: string;
  roles: string[];
  scoped: boolean;
}

/**
 * Whether the handler injects a proven scope. A param decorator's only trace on a method is an entry
 * in `ROUTE_ARGS_METADATA` under a `…__customRouteArgs__:<index>` key, carrying the factory function
 * itself — which is why those two factories are named rather than anonymous arrows.
 */
function injectsProvenScope(controller: NewableFunction, methodName: string): boolean {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) as
    | Record<string, { factory?: (...a: never[]) => unknown }>
    | undefined;
  if (!args) return false;
  return Object.values(args).some((a) => a.factory && SCOPE_FACTORIES.has(a.factory.name));
}

function collectRoutes(): Route[] {
  const routes: Route[] = [];
  for (const mod of Object.values(CONTROLLER_MODULES)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controller = exported as NewableFunction;
      if (Reflect.getMetadata(PATH_METADATA, controller) === undefined) continue;
      const proto = controller.prototype as Record<string, unknown>;
      for (const methodName of Object.getOwnPropertyNames(proto)) {
        if (methodName === 'constructor') continue;
        const handler = proto[methodName];
        if (typeof handler !== 'function') continue;
        const verbCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        const verb = verbCode === undefined ? undefined : WRITE_METHODS.get(verbCode);
        if (!verb) continue;
        const roles = (Reflect.getMetadata(ROLES_KEY, handler) ??
          Reflect.getMetadata(ROLES_KEY, controller) ??
          []) as string[];
        if (!roles.some((r) => ACTING_CAPABLE.includes(r))) continue;
        routes.push({
          key: `${controller.name}.${methodName}`,
          controller: controller.name,
          method: methodName,
          verb,
          path: String(Reflect.getMetadata(PATH_METADATA, handler) ?? ''),
          roles,
          scoped: injectsProvenScope(controller, methodName),
        });
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

describe('#341 AC1 — every manager write route narrows by the proven acting scope', () => {
  const routes = collectRoutes();

  it('the sweep actually saw the app', () => {
    // A collector that silently found nothing would make every assertion below vacuously true — the
    // one failure mode a structural test cannot survive.
    expect(routes.length).toBeGreaterThan(30);
  });

  it('no manager write route builds its scope from claims instead of the proven context', () => {
    const unscoped = routes.filter((r) => !r.scoped && UNSCOPED[r.key] === undefined);
    expect(
      unscoped.map((r) => `${r.key}  (${r.verb} ${r.path || '/'})`),
    ).toEqual([]);
  });

  it('every allowlist entry still names a real route', () => {
    // An entry whose route was renamed or deleted is a suppression nobody is reading any more, and it
    // would silently cover the next route that happens to take the same name.
    const known = new Set(routes.map((r) => r.key));
    expect(Object.keys(UNSCOPED).filter((k) => !known.has(k))).toEqual([]);
  });

  it('no controller assembles a scope from the caller’s claims', () => {
    // The other half, and the one that catches a handler which injects `@CurrentActor()` for
    // attribution and then passes a claims-built scope anyway — real injection, pan-India reach.
    expect(claimsScopeFiles()).toEqual([]);
  });

  it('every claims-scope allowance still names a file that has one', () => {
    const offenders = new Set(
      controllerFiles(CONTROLLER_DIR)
        .map((f) => ({ file: f, relative: f.slice(CONTROLLER_DIR.length + 1).split(sep).join('/') }))
        .filter(({ file }) => CLAIMS_SCOPE.test(code(readFileSync(file, 'utf8'))))
        .map(({ relative }) => relative),
    );
    expect(Object.keys(CLAIMS_SCOPE_ALLOWED).filter((k) => !offenders.has(k))).toEqual([]);
  });

  it('every allowlist entry is a route that is genuinely unscoped', () => {
    // The mirror image: an entry for a route that has since been scoped is stale, and leaving it lets
    // a later un-scoping pass unnoticed.
    const scoped = new Set(routes.filter((r) => r.scoped).map((r) => r.key));
    expect(Object.keys(UNSCOPED).filter((k) => scoped.has(k))).toEqual([]);
  });
});
