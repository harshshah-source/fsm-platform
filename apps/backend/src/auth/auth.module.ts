import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InMemoryRefreshTokenStore } from './refresh-token-store';
import { TokenService } from './token.service';
import { InMemoryUserStore } from './user-store';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, InMemoryUserStore, InMemoryRefreshTokenStore],
  exports: [TokenService], // AuthGuard consumes this for verification.
})
export class AuthModule {}
