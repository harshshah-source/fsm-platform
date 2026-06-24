import type { INestApplication } from '@nestjs/common';

/**
 * Shared HTTP bootstrap used by both `main.ts` and the e2e tests, so production and tests
 * agree on prefix + CORS. `credentials: true` is set now so the httpOnly refresh-cookie
 * fast-follow needs no CORS change.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.ADMIN_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });
}
