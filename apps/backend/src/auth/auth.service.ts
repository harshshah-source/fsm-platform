import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginResponse } from '@fsm/shared';
import { InMemoryRefreshTokenStore } from './refresh-token-store';
import { TokenService } from './token.service';
import { AuthenticatedUser, InMemoryUserStore } from './user-store';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: InMemoryUserStore,
    private readonly tokens: TokenService,
    private readonly refreshTokens: InMemoryRefreshTokenStore,
  ) {}

  login(email: string, password: string): LoginResponse {
    const user = this.users.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException();
    }
    return this.issueTokens(user);
  }

  refresh(refreshToken: string): LoginResponse {
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

  private issueTokens(user: AuthenticatedUser): LoginResponse {
    const accessToken = this.tokens.signAccessToken({
      user_id: user.userId,
      role: user.role,
      zone_id: user.zoneId,
    });
    const refreshToken = this.refreshTokens.issue(user.userId);
    return { accessToken, refreshToken };
  }
}
