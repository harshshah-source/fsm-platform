import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { LatLng } from './distance';

/** The narrow slice of the client this raw-SQL read touches — a transaction client satisfies it too. */
type PlantGeometryClient = Pick<PrismaService, '$queryRaw'>;

/**
 * Every plant's coordinates in one zone, read ONCE per zone-run (#267 AC — cost is bounded by plants
 * per zone, never by tickets or candidates). `plants.location` is `Unsupported("geometry(Point,
 * 4326)")` (`schema.prisma`), invisible to the generated Prisma client — the same raw-SQL seam
 * `candidate-selection.service.ts` already uses for a PostGIS-backed table.
 *
 * A plant with a NULL `location` is simply absent from the returned map — never a fabricated `(0,0)`,
 * which is a real point in the Gulf of Guinea and would hand every candidate targeting that plant a
 * spectacular fake distance. The caller reads an absent entry as NOT_AVAILABLE, the same honesty
 * convention as a candidate with no home base (`hard-filters.ts`'s `FilterState`, #270).
 */
export async function plantCoordinatesForZone(
  prisma: PlantGeometryClient,
  zoneId: bigint,
): Promise<Map<string, LatLng>> {
  const rows = await prisma.$queryRaw<{ plant_id: bigint; lat: number; lng: number }[]>(
    Prisma.sql`
      SELECT plant_id, ST_Y(location) AS lat, ST_X(location) AS lng
      FROM plants
      WHERE zone_id = ${zoneId} AND location IS NOT NULL`,
  );
  return new Map(rows.map((r) => [String(r.plant_id), { lat: r.lat, lng: r.lng }]));
}
