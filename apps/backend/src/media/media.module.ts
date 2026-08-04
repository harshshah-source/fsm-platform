import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaService } from './media.service';

/**
 * Media Upload API (Issue 81, D-12) — the photo-capture seam consumed by #58/#61/#71.
 * `MediaController` is registered in AppModule, same pattern as `VouchersController`.
 */
@Module({
  imports: [PrismaModule],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
