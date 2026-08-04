import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaRefreshTokenStore } from './prisma-refresh-token-store';
import { PrismaUserStore } from './prisma-user-store';
import { TokenService } from './token.service';

@Module({
  imports: [NotificationsModule], // DeviceTokenService — logout clears the user's push token (#76).
  controllers: [AuthController],
  providers: [AuthService, TokenService, PrismaUserStore, PrismaRefreshTokenStore],
  exports: [TokenService], // AuthGuard consumes this for verification.
})
export class AuthModule {}
