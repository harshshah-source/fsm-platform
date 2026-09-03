import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { incrementWarehouseStock } from '../src/inventory/warehouse-stock.service';

/**
 * Issue 73 — zone-warehouse stock read + WM-managed set/adjust (`/api/inventory/warehouse-stock`) and
 * the Component-Request Fulfilment-SLA KPI. WM/managers read (ZM zone-scoped); WM/OH set (audited).
 */
const NS = Date.now();

describe('Warehouse stock (Issue 73, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let componentId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ws-' + NS } })).zoneId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'GPS Antenna ' + NS } })).componentId;
  });

  afterAll(async () => {
    await prisma.zoneWarehouseStock.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'zone_warehouse_stock', entityId: `${zoneId}:${componentId}` } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('lets the Warehouse Manager set stock, then reads it back with derived available + low-stock', async () => {
    const wm = await login('wm@fsm.test');
    const patch = await request(app.getHttpServer())
      .patch('/api/inventory/warehouse-stock')
      .set('Authorization', `Bearer ${wm}`)
      .send({ zoneId: Number(zoneId), componentId: Number(componentId), onHand: 8, reserved: 3, lowStockThreshold: 6 })
      .expect(200);
    expect(patch.body.available).toBe(5); // 8 − 3
    expect(patch.body.lowStock).toBe(true); // available(5) ≤ threshold(6)

    const list = await request(app.getHttpServer()).get('/api/inventory/warehouse-stock').set('Authorization', `Bearer ${wm}`).expect(200);
    const row = (list.body as { componentId: string; onHand: number; available: number; zoneName: string }[]).find((r) => r.componentId === String(componentId));
    expect(row).toBeDefined();
    expect(row!.onHand).toBe(8);
    expect(row!.available).toBe(5);
    expect(row!.zoneName).toBe('Z-ws-' + NS);
  });

  it('writes an audit row for a stock set', async () => {
    const wm = await login('wm@fsm.test');
    await request(app.getHttpServer())
      .patch('/api/inventory/warehouse-stock')
      .set('Authorization', `Bearer ${wm}`)
      .send({ zoneId: Number(zoneId), componentId: Number(componentId), onHand: 20 })
      .expect(200);
    const audits = await prisma.auditLog.count({ where: { action: 'WAREHOUSE_STOCK_SET', entityId: `${zoneId}:${componentId}` } });
    expect(audits).toBeGreaterThanOrEqual(1);
  });

  it('returns the fulfilment-SLA KPI shape', async () => {
    const wm = await login('wm@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/inventory/warehouse-stock/fulfillment-sla').set('Authorization', `Bearer ${wm}`).expect(200);
    expect(res.body).toHaveProperty('totalReceived');
    expect(res.body).toHaveProperty('withinSlaPct');
    expect(res.body).toHaveProperty('openRequests');
  });

  it('excludes stock outside the ZM zone', async () => {
    const zm = await login('zm.north@fsm.test'); // zone 1, not the seeded zone
    const res = await request(app.getHttpServer()).get('/api/inventory/warehouse-stock').set('Authorization', `Bearer ${zm}`).expect(200);
    expect((res.body as { componentId: string }[]).some((r) => r.componentId === String(componentId))).toBe(false);
  });

  /**
   * #353 — the ledger's only increment door. `setStock` writes an absolute count, which is the wrong
   * shape for something arriving: two receipts landing on one level must add, not overwrite, and the
   * first arrival for a SKU a zone has never held must create the row rather than fail. It takes a
   * transaction client on purpose — the caller (a recovery receipt) has its own commit to join.
   */
  it('increments zone stock from zero and adds to an existing level, inside the caller transaction', async () => {
    const fresh = (await prisma.componentMaster.create({ data: { name: 'Recovery SKU ' + NS } })).componentId;
    try {
      await prisma.$transaction(async (tx) => {
        await incrementWarehouseStock(tx, zoneId, fresh, 1);
      });
      const created = await prisma.zoneWarehouseStock.findUniqueOrThrow({ where: { zoneId_componentId: { zoneId, componentId: fresh } } });
      expect(created.onHand).toBe(1);
      expect(created.reserved).toBe(0);

      await prisma.$transaction(async (tx) => {
        await incrementWarehouseStock(tx, zoneId, fresh, 3);
      });
      const grown = await prisma.zoneWarehouseStock.findUniqueOrThrow({ where: { zoneId_componentId: { zoneId, componentId: fresh } } });
      expect(grown.onHand).toBe(4);

      // a caller that rolls back leaves the level exactly where it was
      await expect(
        prisma.$transaction(async (tx) => {
          await incrementWarehouseStock(tx, zoneId, fresh, 10);
          throw new Error('caller rolled back');
        }),
      ).rejects.toThrow('caller rolled back');
      const unchanged = await prisma.zoneWarehouseStock.findUniqueOrThrow({ where: { zoneId_componentId: { zoneId, componentId: fresh } } });
      expect(unchanged.onHand).toBe(4);
    } finally {
      await prisma.zoneWarehouseStock.deleteMany({ where: { componentId: fresh } });
      await prisma.componentMaster.deleteMany({ where: { componentId: fresh } });
    }
  });

  it('forbids a Service Engineer from reading warehouse stock', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/inventory/warehouse-stock').set('Authorization', `Bearer ${se}`).expect(403);
  });
});
