import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DevZoneResolver } from './dev-zone-resolver';
import { InMemoryRefreshTokenStore } from './refresh-token-store';
import { TokenService } from './token.service';
import { InMemoryUserStore } from './user-store';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    InMemoryUserStore,
    InMemoryRefreshTokenStore,
    // DEV-ONLY scaffold — remove with Issue #91 (see dev-zone-resolver.ts).
    DevZoneResolver,
  ],
  exports: [TokenService], // AuthGuard consumes this for verification.
})
export class AuthModule {}
