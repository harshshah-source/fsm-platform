import 'reflect-metadata'; //Librabry for decorator
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { runWithFatalGuard } from './bootstrap-guard';
import { validateBootConfig } from './config/boot-config';
import { PrismaService } from './prisma/prisma.service';
import { DispatchScheduleService } from './scheduling/dispatch-schedule.service';

async function bootstrap(): Promise<void> { //async because starting the application takes time
  // Fail-fast before any module boots: refuse to start on a missing/unsafe secret or bad DB URL (#98).
  validateBootConfig();
  //checks from .env about jwt and databaseurl


  //auto-commments: 
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
// NestJS reads AppModule (which lists every feature module: auth, tickets, scheduling, etc.) and wires the entire application together: every controller, every service, every database connection, every scheduled job.


  // SIGTERM/SIGINT now run the Nest lifecycle, so onModuleDestroy (Prisma $disconnect, AutoPlant MySQL
  // pool end) actually fires on a graceful shutdown instead of the process being hard-killed (#98).
  app.enableShutdownHooks(); //gracefull shutdown

  configureApp(app);//confidure route

  await app.listen(process.env.PORT ?? 3000); //start tbhe port.

  // #257 — apply the operator's stored dispatch schedule to the live cron job. This cannot live in a
  // lifecycle hook: @Cron jobs are mounted into SchedulerRegistry by SchedulerOrchestrator's OWN
  // onApplicationBootstrap, and Nest runs bootstrap hooks deepest-module-first, which on this graph
  // puts SchedulingModule's hook before the orchestrator's. Only here, after listen() resolves, is
  // every module's bootstrap guaranteed complete — so only here does the job reliably exist.
  await app.get(DispatchScheduleService).applyStoredSchedule();
}

const logger = new Logger('Bootstrap');
void runWithFatalGuard(bootstrap, {
  exit: (code) => process.exit(code),
  logFatal: (message) => logger.fatal(message),
});
