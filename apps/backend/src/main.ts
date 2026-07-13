import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { runWithFatalGuard } from './bootstrap-guard';
import { validateBootConfig } from './config/boot-config';

async function bootstrap(): Promise<void> {
  // Fail-fast before any module boots: refuse to start on a missing/unsafe secret or bad DB URL (#98).
  validateBootConfig();
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
