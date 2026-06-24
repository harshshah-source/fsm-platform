import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global so every feature module shares the one pooled Prisma connection. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
