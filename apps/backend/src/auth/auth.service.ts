import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginResponse } from '@fsm/shared';
import { PrismaRefreshTokenStore } from './prisma-refresh-token-store';
import { AuthenticatedUser, PrismaUserStore } from './prisma-user-store';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: PrismaUserStore,
    private readonly tokens: TokenService,
    private readonly refreshTokens: PrismaRefreshTokenStore,
  ) {}

  async login(email: string, password: string, deviceId: string): Promise<LoginResponse> {
    const user = await this.users.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException();
    }
    return this.issueTokens(user, deviceId);
  }

  async refresh(refreshToken: string, deviceId?: string): Promise<LoginResponse> {
    const consumed = await this.refreshTokens.consume(refreshToken); // single-use: rotates + revokes
    if (!consumed) {
      throw new UnauthorizedException();
    }
    const user = await this.users.findById(consumed.userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    // A refresh call that carries no X-Device-Id (no client sends one yet — tracked on #54) stays
    // attributed to the device the rotated token was originally issued on, so a routine token
    // rotation never masquerades as a new-device login and revokes itself.
    return this.issueTokens(user, deviceId ?? consumed.deviceId, consumed.tokenId);
  }

  /** Revokes the presented refresh token. Silently no-ops on an unknown/already-revoked token —
   * logout must not become an oracle for whether a given token was ever valid. */
  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokens.revoke(refreshToken, 'LOGOUT');
  }

  private async issueTokens(
    user: AuthenticatedUser,
    deviceId: string,
    rotatedFrom?: bigint,
  ): Promise<LoginResponse> {
    const accessToken = this.tokens.signAccessToken({
      user_id: user.userId,
      role: user.role,
      zone_id: user.zoneId,
    });
    const refreshToken = await this.refreshTokens.issue({ userId: user.userId, deviceId, rotatedFrom });
    return { accessToken, refreshToken };
  }
}
