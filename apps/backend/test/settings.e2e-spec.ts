import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * TB9 — the system_settings registry is seeded with canonical defaults and readable
 * through SettingsService. Seeding is idempotent and must not clobber operator changes;
 * here we only assert a freshly-seeded default reads back.
 */
describe('TB9 — system_settings default read', () => {
  let prisma: PrismaService;
  let settings: SettingsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    settings = new SettingsService(prisma);
    await settings.seedDefaults();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('reads the seeded default for the inactivity threshold (24h)', async () => {
    expect(await settings.get('inactivity_threshold_hours')).toBe(24);
  });
});
