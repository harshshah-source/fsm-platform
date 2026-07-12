import {
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  Module,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Global exception filter (#98 leg 5). Unhandled errors must return a sanitized JSON body — no stack,
 * no internal detail leaked — carry a correlation id, and never surface as a raw 500. HttpExceptions
 * keep their status + safe message. Tested in isolation with a throwing controller so no real route
 * has to be made to fail.
 */
@Controller()
class BoomController {
  @Get('boom')
  boom(): never {
    throw new Error('kaboom SECRET internal detail');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('resource gone');
  }

  @Get('coded')
  coded(): never {
    throw new ConflictException({ code: 'CUSTOM_CONFLICT' });
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

describe('AllExceptionsFilter (#98, e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BoomModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps an unhandled error to a sanitized 500 with no stack or internal detail', async () => {
    const res = await request(app.getHttpServer()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.statusCode).toBe(500);
    expect(res.body.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.body.stack).toBeUndefined();
    expect(res.body.path).toBe('/boom');
  });

  it('attaches a correlation id to the body and the x-correlation-id header', async () => {
    const res = await request(app.getHttpServer()).get('/boom');
    expect(res.headers['x-correlation-id']).toBeTruthy();
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('reuses an inbound x-correlation-id when the caller supplies one', async () => {
    const cid = 'test-correlation-abc123';
    const res = await request(app.getHttpServer()).get('/boom').set('x-correlation-id', cid);
    expect(res.headers['x-correlation-id']).toBe(cid);
    expect(res.body.correlationId).toBe(cid);
  });

  it('preserves an HttpException body/status verbatim and tags it via the header (contract unchanged)', async () => {
    const res = await request(app.getHttpServer()).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
    expect(res.body.message).toBe('resource gone'); // Nest default body preserved, not reshaped
    expect(res.headers['x-correlation-id']).toBeTruthy();
    expect(res.body.stack).toBeUndefined();
  });

  it('preserves a controller-authored structured error body (e.g. { code }) unchanged', async () => {
    const res = await request(app.getHttpServer()).get('/coded');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOM_CONFLICT'); // the { code } contract survives the filter
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });
});
