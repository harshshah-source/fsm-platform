import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { runWithFatalGuard } from './bootstrap-guard';
import { validateBootConfig } from './config/boot-config';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  // Fail-fast before any module boots: refuse to start on a missing/unsafe secret or bad DB URL (#98).
  validateBootConfig();
  // #130 belt-and-braces: run the build guard (L4 schema-skew → L1 version lock) before Nest even
  // constructs the module graph, so a stale/skewed build of the HTTP server fails fast. The structural
  // guarantee remains PrismaService.onModuleInit (which every entrypoint runs); this is the earlier
  // tripwire. A refusal throws here and runWithFatalGuard turns it into a single fatal line + exit.
  const preflight = new PrismaService();
  try {
    await preflight.onModuleInit();
  } finally {
    await preflight.onModuleDestroy();
  }
  // bodyParser off so configureApp's explicit, env-tunable JSON limit is the ONLY parser (#99).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // SIGTERM/SIGINT now run the Nest lifecycle, so onModuleDestroy (Prisma $disconnect, AutoPlant MySQL
  // pool end) actually fires on a graceful shutdown instead of the process being hard-killed (#98).
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

const logger = new Logger('Bootstrap');
void runWithFatalGuard(bootstrap, {
  exit: (code) => process.exit(code),
  logFatal: (message) => logger.fatal(message),
});
