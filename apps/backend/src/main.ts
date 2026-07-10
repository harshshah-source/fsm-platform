import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { validateBootConfig } from './config/boot-config';

async function bootstrap(): Promise<void> {
  // Fail-fast before any module boots: refuse to start on a missing/unsafe secret or bad DB URL (#98).
  validateBootConfig();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
