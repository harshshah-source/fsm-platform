import { VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Shared HTTP bootstrap used by both `main.ts` and the e2e tests, so production and tests
 * agree on prefix + CORS + body limits. `credentials: true` is set now so the httpOnly
 * refresh-cookie fast-follow needs no CORS change.
 *
 * Body limit (#99): an explicit, env-tunable JSON cap replaces the accidental body-parser
 * default. 1 MB comfortably fits the largest legitimate payload (an install CSV bulk upload
 * at the 1,000-row cap) while stopping oversized bodies at the edge with a clean 413.
 * Requires the app to be created with `bodyParser: false` (see `main.ts`) — otherwise the
 * default parser registers first and its limit wins; test apps that skip that option simply
 * keep the default parser, so this is additive there.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  // #169 / Wave 0 — a version segment must exist BEFORE a mobile client ships, because adding `/v1`
  // once v1 is in the field is itself the breaking change versioning exists to prevent, and there is
  // no OTA channel to fix a client that hard-codes the wrong base path (#170).
  //
  // `defaultVersion: ['1', VERSION_NEUTRAL]` registers every route at BOTH `/api/v1/...` and
  // `/api/...`. That is deliberate and load-bearing: 90 backend e2e specs and every `apps/admin` API
  // module call the unversioned path today, so a hard switch would break both apps at once. The
  // neutral alias is the migration window — do not remove it until the admin client is repointed.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: ['1', VERSION_NEUTRAL],
  });
  app.enableCors({
    origin: process.env.ADMIN_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });
  const express = app as NestExpressApplication;
  if (typeof express.useBodyParser === 'function') {
    express.useBodyParser('json', { limit: process.env.BODY_LIMIT_JSON ?? '1mb' });
  }
}
