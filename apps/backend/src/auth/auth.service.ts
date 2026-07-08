import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginResponse } from '@fsm/shared';
import { DevZoneResolver } from './dev-zone-resolver';
import { InMemoryRefreshTokenStore } from './refresh-token-store';
import { TokenService } from './token.service';
import { AuthenticatedUser, InMemoryUserStore } from './user-store';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: InMemoryUserStore,
    private readonly tokens: TokenService,
    private readonly refreshTokens: InMemoryRefreshTokenStore,
    // DEV-ONLY scaffold — remove with Issue #91 (see dev-zone-resolver.ts).
    private readonly devZone: DevZoneResolver,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = this.users.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException();
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<LoginResponse> {
    const userId = this.refreshTokens.consume(refreshToken); // single-use: rotates + revokes
    if (!userId) {
      throw new UnauthorizedException();
    }
    const user = this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    return this.issueTokens(user);
  }

  private async issueTokens(user: AuthenticatedUser): Promise<LoginResponse> {
    // DEV-ONLY: lets the static dev `zone_id` track live seeded zones (Issue #91 removes this).
    // Default-off — identical to `user.zoneId` unless DEV_AUTH_ZONE is set. Claim shape unchanged.
    const zoneId = await this.devZone.resolveZoneId(user);
    const accessToken = this.tokens.signAccessToken({
      user_id: user.userId,
      role: user.role,
      zone_id: zoneId,
    });
    const refreshToken = this.refreshTokens.issue(user.userId);
    return { accessToken, refreshToken };
  }
}
